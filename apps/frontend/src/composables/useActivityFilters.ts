// URL-synced project + repository filter pair with interlock: picking a
// repo auto-selects its project (one-to-one by data model); picking a
// project trims the repo dropdown and clears a now-mismatched repo. Both
// axes live in `route.query` (deep links + Back button), coalesced into a
// single `router.replace` per change. `pinProject` keeps the repo dropdown
// scoped to a fixed project regardless of `?project=` (project-detail pages).

import { computed, type ComputedRef, type Ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { TrackedRepositorySummary } from '@/api/client';

export interface UseActivityFiltersOptions {
  // Source of truth for the repo list (project mapping comes from here).
  // Ref so reactivity works for both ref-shaped store values and computeds.
  repositories: Ref<readonly TrackedRepositorySummary[]> | ComputedRef<readonly TrackedRepositorySummary[]>;
  // When set, the repo dropdown is always scoped to this project regardless
  // of `?project=`. Used on project-detail pages (project fixed by route).
  pinProject?: () => string | undefined;
  // Custom query-param keys so a page already using `?project` for a
  // different control can host an independent filter pair. Defaults to
  // project / repo.
  queryKeys?: { project?: string; repo?: string };
}

export function useActivityFilters(opts: UseActivityFiltersOptions) {
  const route = useRoute();
  const router = useRouter();
  const pKey = opts.queryKeys?.project ?? 'project';
  const rKey = opts.queryKeys?.repo ?? 'repo';

  const filterProject = computed<string | undefined>(() => {
    const raw = route.query[pKey];
    return typeof raw === 'string' && raw !== '' ? raw : undefined;
  });
  const filterRepo = computed<string | undefined>(() => {
    const raw = route.query[rKey];
    return typeof raw === 'string' && raw !== '' ? raw : undefined;
  });

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
    if (v === undefined || v === '') delete next[pKey];
    else next[pKey] = v;
    // Interlock: if the new project doesn't include the current repo,
    // drop the repo selection so the dropdowns stay coherent.
    if (v !== undefined && v !== '' && typeof next[rKey] === 'string') {
      const repo = opts.repositories.value.find((r) => r.fullName === next[rKey]);
      if (repo && repo.project !== v) delete next[rKey];
    }
    void router.replace({ query: next });
  }

  function setRepo(v: string | undefined): void {
    const next = { ...route.query };
    if (v === undefined || v === '') delete next[rKey];
    else next[rKey] = v;
    // Interlock: auto-select the chosen repo's project (a repo belongs to
    // exactly one project). Skip when pinned — the project is already known
    // from the route, so writing it to the query just adds noise.
    if (v !== undefined && v !== '' && opts.pinProject === undefined) {
      const repo = opts.repositories.value.find((r) => r.fullName === v);
      if (repo?.project !== null && repo?.project !== undefined && repo.project !== next[pKey]) {
        next[pKey] = repo.project;
      }
    }
    void router.replace({ query: next });
  }

  // Write-side models so callers can use `v-model` on `<select>` (write
  // runs the interlock via the setter).
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
