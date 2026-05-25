// Phase 5 — shared URL-synced activity-actor filter. Reads / writes the
// `?actor` + `?actorKind` query pair as a single ActivityActor, so every
// page that filters the activity feed by contributor (Dashboard,
// Activity, Projects, Project detail, Repo detail) stays in lockstep on
// the encoding. `actorKind` is omitted for users to keep the common URL
// compact and backward-compatible with pre-Phase-5 `?actor=5` links.
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { ActivityActor } from '@/api/client';

export function useActorFilter() {
  const route = useRoute();
  const router = useRouter();
  return computed<ActivityActor | undefined>({
    get: (): ActivityActor | undefined => {
      const raw = route.query.actor;
      if (typeof raw !== 'string') return undefined;
      const id = Number(raw);
      if (!Number.isFinite(id) || id <= 0) return undefined;
      const kind: ActivityActor['kind'] = route.query.actorKind === 'person' ? 'person' : 'user';
      return { kind, id };
    },
    set: (v: ActivityActor | undefined) => {
      const next = { ...route.query };
      if (v === undefined) {
        delete next.actor;
        delete next.actorKind;
      } else {
        next.actor = String(v.id);
        if (v.kind === 'person') next.actorKind = 'person';
        else delete next.actorKind;
      }
      void router.replace({ query: next });
    },
  });
}
