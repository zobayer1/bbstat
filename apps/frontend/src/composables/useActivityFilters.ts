// URL-synced project + repository filter pair with interlock.
//
// Anywhere both a project AND a repository dropdown render together,
// selecting one needs to keep the other coherent:
//   - Pick a repo → the page knows that repo's project (one-to-one
//     by data model); auto-select it so the project dropdown stays
//     accurate.
//   - Pick a project → the repo dropdown trims to that project's repos;
//     a previously selected repo from a different project is cleared.
//
// Both axes live in `route.query` so deep links work and the browser's
// Back button does what the user expects. URL updates are coalesced
// into a single `router.replace` per change so we don't ping-pong
// query strings on the interlock writes.
//
// Project-detail pages can pin the project via `pinProject` — the
// repo dropdown then stays trimmed to that project regardless of any
// `?project=` in the URL, and callers typically don't render the
// project dropdown at all on those pages.

import { computed, type ComputedRef, type Ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { TrackedRepositorySummary } from '@/api/client';

export interface UseActivityFiltersOptions {
  // Source of truth for the repo list (project mapping comes from here).
  // Accept a Ref so reactivity works whether the caller has a ref-shaped
  // store value (stats.repositories is a ref) or a computed.
  repositories: Ref<readonly TrackedRepositorySummary[]> | ComputedRef<readonly TrackedRepositorySummary[]>;
  // Optional pin — when set, the repo dropdown is always scoped to
  // this project regardless of the URL `?project=` value. Used on
  // project-detail pages where the project is fixed by the route.
  pinProject?: () => string | undefined;
}

export function useActivityFilters(opts: UseActivityFiltersOptions) {
  const route = useRoute();
  const router = useRouter();

  const filterProject = computed<string | undefined>(() =>
    typeof route.query.project === 'string' && route.query.project !== '' ? route.query.project : undefined,
  );
  const filterRepo = computed<string | undefined>(() =>
    typeof route.query.repo === 'string' && route.query.repo !== '' ? route.query.repo : undefined,
  );

  const projectOptions = computed<string[]>(() => {
    const set = new Set<string>();
    for (const r of opts.repositories.value) if (r.project !== null) set.add(r.project);
    return Array.from(set).sort();
  });

  const repoOptions = computed<readonly TrackedRepositorySummary[]>(() => {
    const pinned = opts.pinProject?.();
    const scope = pinned ?? filterProject.value;
    if (scope === undefined) return opts.repositories.value;
    return opts.repositories.value.filter((r) => r.project === scope);
  });

  function setProject(v: string | undefined): void {
    const next = { ...route.query };
    if (v === undefined || v === '') delete next.project;
    else next.project = v;
    // Interlock: if the new project doesn't include the current repo,
    // drop the repo selection so the dropdowns stay coherent.
    if (v !== undefined && v !== '' && typeof next.repo === 'string') {
      const repo = opts.repositories.value.find((r) => r.fullName === next.repo);
      if (repo && repo.project !== v) delete next.repo;
    }
    void router.replace({ query: next });
  }

  function setRepo(v: string | undefined): void {
    const next = { ...route.query };
    if (v === undefined || v === '') delete next.repo;
    else next.repo = v;
    // Interlock: auto-select the chosen repo's project so the project
    // dropdown reflects reality (a repo belongs to exactly one project).
    // Skip when `pinProject` is set — the project is already known to
    // the page from the route, and writing it to the query string just
    // adds redundant noise.
    if (v !== undefined && v !== '' && opts.pinProject === undefined) {
      const repo = opts.repositories.value.find((r) => r.fullName === v);
      if (repo?.project !== null && repo?.project !== undefined && repo.project !== next.project) {
        next.project = repo.project;
      }
    }
    void router.replace({ query: next });
  }

  // Convenience write-side models so callers can keep using `v-model`
  // on `<select>` elements (read = computed getter, write = setter that
  // also runs the interlock).
  const projectModel = computed<string | undefined>({
    get: () => filterProject.value,
    set: (v) => setProject(v),
  });
  const repoModel = computed<string | undefined>({
    get: () => filterRepo.value,
    set: (v) => setRepo(v),
  });

  return {
    filterProject,
    filterRepo,
    projectModel,
    repoModel,
    projectOptions,
    repoOptions,
    setProject,
    setRepo,
  };
}
