<script setup lang="ts">
// Breadcrumb trail shown in the header of every non-dashboard page, replacing
// the old static "← Dashboard" back-link. The home (dashboard) crumb is always
// rendered first as a home icon + "Home"; callers pass the rest of the trail
// via `items`. Each crumb shows an icon + label — the icons are the same
// @/lib/glyphs shapes the dashboard stat cards use (Repositories → folder,
// Projects → rectangleStack, Members → users, Commits → bolt). A crumb with
// `to` is a link; the last/current crumb omits `to` and renders as plain text.
//
//   Index page:  <Breadcrumb :items="[{ label: 'Projects', icon: GLYPHS.rectangleStack }]" />
//   Detail page: <Breadcrumb :items="[
//                  { label: 'Projects', to: '/projects', icon: GLYPHS.rectangleStack },
//                  { label: projectKey, icon: GLYPHS.rectangleStack },
//                ]" />
import { RouterLink } from 'vue-router';
import { GLYPHS } from '@/lib/glyphs';

export interface BreadcrumbItem {
  label: string;
  // Route path. Omitted on the current page (rendered as text, not a link).
  to?: string;
  // Heroicons-outline glyph `d` path (from @/lib/glyphs), shown before the
  // label. Omit for a text-only crumb (e.g. a specific id leaf).
  icon?: string;
  // Wrap the label in [brackets] — used for leaf crumbs that name a specific
  // instance (a repo / project / person) rather than a section, signalling
  // "this is a particular id" and pairing with the absence of a section icon.
  bracketed?: boolean;
}

defineProps<{ items: BreadcrumbItem[] }>();
</script>

<template>
  <nav aria-label="Breadcrumb" class="text-xs text-slate-500">
    <ol class="flex flex-wrap items-center gap-1.5">
      <li class="flex items-center">
        <RouterLink to="/" class="inline-flex items-center gap-1 transition-colors hover:text-slate-700">
          <svg
            class="h-4 w-4 shrink-0"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke-width="1.8"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path stroke-linecap="round" stroke-linejoin="round" :d="GLYPHS.home" />
          </svg>
          Home
        </RouterLink>
      </li>
      <li v-for="(item, index) in items" :key="index" class="flex items-center gap-1.5">
        <!-- separator -->
        <svg
          class="h-3 w-3 shrink-0 text-slate-300"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          stroke-width="2"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
        </svg>
        <component
          :is="item.to ? RouterLink : 'span'"
          :to="item.to"
          :aria-current="item.to ? undefined : 'page'"
          class="inline-flex items-center gap-1"
          :class="item.to ? 'transition-colors hover:text-slate-700' : 'font-medium text-slate-700'"
        >
          <svg
            v-if="item.icon"
            class="h-4 w-4 shrink-0"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke-width="1.8"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path stroke-linecap="round" stroke-linejoin="round" :d="item.icon" />
          </svg>
          {{ item.bracketed ? `[${item.label}]` : item.label }}
        </component>
      </li>
    </ol>
  </nav>
</template>
