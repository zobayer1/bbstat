<script setup lang="ts">
// Methodology modal opened from the Members page header. Explains the
// ShipShow Score equations, constants, and current calibration; equations
// render via KaTeX. Full design rationale lives in docs/scoring.md.
//
// Keyboard: Esc closes. Closes on backdrop click and the X button.

import katex from 'katex';
import 'katex/dist/katex.min.css';
import { onMounted, onUnmounted } from 'vue';

const emit = defineEmits<{
  close: [];
}>();

// Mirrored from apps/backend/src/scoring/constants.ts — update both. Kept as
// literals so the modal stays self-contained; an API round-trip isn't worth it
// for ~6 numbers.
const STATIC = {
  alpha: 1.2,
  floor: 500,
  halfLifeDays: 30,
  beta: 0.25,
  consistencyWindowDays: 90,
  steadyEddieGoldPct: 10,
  steadyEddieSilverPct: 50,
} as const;

// `throwOnError: false` renders bad LaTeX as red source text instead of
// crashing the whole component — a safety net while iterating on formulas.
function tex(src: string): string {
  return katex.renderToString(src, { displayMode: true, throwOnError: false });
}

const eqCommitScore = tex(String.raw`
\begin{aligned}
c_i &= a_i + d_i \\
\mathrm{cap} &= \max\!\left(p^{\,\mathrm{dev}}_{95},\ F\right) \\
r_i &= \min\!\left(1,\ \frac{\mathrm{cap}}{c_i}\right) \\
s_i &= \ln(1 + r_i\, a_i) \;+\; \alpha \, \ln(1 + r_i\, d_i)
\end{aligned}
`);

const eqMomentum = tex(String.raw`
M(d) \;=\; \sum_{i} s_i \cdot e^{-\lambda \,(t_{\mathrm{now}} - t_i)}
\quad\text{where}\quad
\lambda = \frac{\ln 2}{H}
`);

const eqConsistency = tex(String.raw`
\begin{aligned}
\text{gaps}_i &= \text{active\_days}_{i+1} - \text{active\_days}_i \\
\text{cv\_gap} &= \frac{\sigma(\text{gaps})}{\mu(\text{gaps})} \\
\text{regularity} &= \frac{1}{1 + \text{cv\_gap}} \;\in (0,1] \\
\text{pace} &= \left(\frac{\text{active\_days}}{${STATIC.consistencyWindowDays}}\right)^{\!\beta} \\
\text{consistency} &= \text{regularity} \cdot \text{pace} \;\in [0,1]
\end{aligned}
`);

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/50 px-4 py-8"
    role="dialog"
    aria-modal="true"
    aria-labelledby="methodology-modal-title"
    @click.self="emit('close')"
  >
    <div class="my-auto w-full max-w-4xl overflow-hidden rounded-lg bg-white shadow-2xl">
      <header class="flex items-center justify-between border-b border-slate-100 px-6 py-4">
        <h2 id="methodology-modal-title" class="text-base font-semibold text-slate-900">How ShipShow Score works</h2>
        <button
          type="button"
          class="cursor-pointer rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          aria-label="Close"
          @click="emit('close')"
        >
          <svg
            viewBox="0 0 16 16"
            class="h-4 w-4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          >
            <path d="M3 3 L13 13 M13 3 L3 13" />
          </svg>
        </button>
      </header>

      <div class="space-y-6 px-6 py-5 text-sm text-slate-700">
        <p class="text-justify">
          Each contributor's row carries two ranked dimensions —
          <strong class="text-slate-900">Momentum</strong> (decayed contribution score) and
          <strong class="text-slate-900">Consistency</strong> (regularity of commit spacing). Neither is blended with
          the other; they're sortable independently.
        </p>

        <section>
          <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Per-commit score</h3>
          <p class="mb-2 text-justify">
            Every eligible commit (non-merge, diff stats fetched, &lt; 3 fetch failures, author identified) contributes
            a single number <em>s<sub>i</sub></em> derived from its line counts, where <em>i</em> indexes the commit in
            the developer's history.
          </p>
          <ul class="mb-3 list-disc space-y-0.5 pl-5 text-xs text-slate-500">
            <li>
              <em>a<sub>i</sub></em
              >, <em>d<sub>i</sub></em> — additions and deletions of the <em>i</em>-th commit.
            </li>
            <li>
              <em>c<sub>i</sub></em> — raw churn of the <em>i</em>-th commit.
            </li>
            <li>
              <em>p<sub>95</sub><sup>dev</sup></em> — the developer's 95th percentile churn across their full ingested
              history. <em>F</em> = {{ STATIC.floor }} is the global FLOOR; together they form the cap so one outlier
              commit can't dwarf years of work.
            </li>
            <li>
              <em>r<sub>i</sub></em> — proportional scaling applied when <em>c<sub>i</sub></em> exceeds the cap.
            </li>
            <li>
              <em>α</em> = {{ STATIC.alpha }} — deletion weight. Set slightly above 1 so refactoring / cleanup earns a
              small premium over equivalent additions.
            </li>
          </ul>
          <!-- eslint-disable-next-line vue/no-v-html -- KaTeX output from a hard-coded LaTeX string, not user input -->
          <div class="overflow-x-auto rounded bg-slate-50 px-4 py-4 text-slate-800" v-html="eqCommitScore"></div>
          <p class="mt-2 text-justify text-xs text-slate-500">
            The split-log form (not a single log of total churn) means a 100/100 commit outscores a 200/0 commit — log's
            concavity penalises scaffolded-file additions vs real edits.
          </p>
        </section>

        <section>
          <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Momentum (the leaderboard rank)
          </h3>
          <p class="mb-3 text-justify">
            Decay makes the leaderboard reflect <em>who is shipping right now</em> rather than career totals — a strong
            month last year contributes less than a quiet one this week. The trade-off is that legitimate long-horizon
            work (a refactor that paid off over months) feels under-represented on the dashboard, even when it's the
            same person.
          </p>
          <p class="mb-2 text-justify">
            <em>M(d)</em> is developer <em>d</em>'s leaderboard score — the time-decayed sum of their per-commit scores
            <em>s<sub>i</sub></em> defined above.
          </p>
          <ul class="mb-3 list-disc space-y-0.5 pl-5 text-xs text-slate-500">
            <li>
              <em>t<sub>i</sub></em> — authoring timestamp of the <em>i</em>-th commit; <em>t<sub>now</sub></em> is the
              rollup time.
            </li>
            <li>
              <em>H</em> = {{ STATIC.halfLifeDays }} days — half-life. <em>λ</em> follows from it. A commit at age
              <em>H</em> counts half; at 2<em>H</em>, a quarter; at a year, ≈ 0.02%.
            </li>
          </ul>
          <!-- eslint-disable-next-line vue/no-v-html -- KaTeX output from a hard-coded LaTeX string, not user input -->
          <div class="overflow-x-auto rounded bg-slate-50 px-4 py-4 text-slate-800" v-html="eqMomentum"></div>
          <p class="mt-2 text-justify text-xs text-slate-500">
            Distant history fades on its own — no hard window cutoff.
          </p>
        </section>

        <section>
          <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Consistency ({{ STATIC.consistencyWindowDays }}-day window)
          </h3>
          <p class="mb-3 text-justify">
            Consistency isolates rhythm from volume — a once-a-week steady contributor reads alongside a daily one. The
            trade-off is that bursty patterns (a single big architectural commit per month) score low here even when the
            work is highly valuable; the metric rewards predictability, not depth.
          </p>
          <p class="mb-3 text-justify">
            Regularity of commit spacing — independent of volume. A daily committer and an every-10-days committer can
            both score high if their spacing is uniform; erratic / one-off patterns score low. The pace exponent
            <span class="font-serif italic">β</span> = {{ STATIC.beta }} is intentionally small so a sparse-but-regular
            contributor isn't crushed.
          </p>
          <!-- eslint-disable-next-line vue/no-v-html -- KaTeX output from a hard-coded LaTeX string, not user input -->
          <div class="overflow-x-auto rounded bg-slate-50 px-4 py-4 text-slate-800" v-html="eqConsistency"></div>
          <p class="mt-2 text-justify text-xs text-slate-500">
            Shows <span class="font-mono">—</span> for fewer than 3 active days (insufficient data to estimate
            <span class="font-serif italic">cv_gap</span>).
          </p>
        </section>

        <section>
          <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Badges</h3>
          <p class="mb-2 text-justify">
            Every contributor active in the last {{ STATIC.consistencyWindowDays }} days lands in a persona; the cascade
            evaluates specialty patterns first and falls through to
            <strong class="text-slate-900">Steady Eddie</strong> as the catch-all. Dormant rows (no activity in window)
            get no badge and are dimmed.
          </p>
          <table class="w-full border-collapse text-xs">
            <thead>
              <tr class="border-b border-slate-200 text-left text-[10px] uppercase tracking-wider text-slate-500">
                <th class="py-1 pr-3 font-medium">Badge</th>
                <th class="py-1 font-medium">Trigger</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100 font-mono text-[11px] text-slate-700">
              <tr>
                <td class="py-1.5 pr-3 font-sans text-slate-900">Fresh Meat</td>
                <td class="py-1.5">days_since_first_commit &lt; 14</td>
              </tr>
              <tr>
                <td class="py-1.5 pr-3 font-sans text-slate-900">Deep Diver</td>
                <td class="py-1.5">median_churn ≥ 200 AND active_days &lt; 15 AND consistency &lt; 0.35</td>
              </tr>
              <tr>
                <td class="py-1.5 pr-3 font-sans text-slate-900">AI Alex</td>
                <td class="py-1.5">p95_churn / median_churn ≥ 20 AND p95_churn ≥ 2000</td>
              </tr>
              <tr>
                <td class="py-1.5 pr-3 font-sans text-slate-900">Cleanup Crew</td>
                <td class="py-1.5">deletions / additions ≥ 1.2 AND commits ≥ 10</td>
              </tr>
              <tr>
                <td class="py-1.5 pr-3 font-sans text-slate-900">Batch Betty</td>
                <td class="py-1.5">regularity ≥ 0.55 AND 3 ≤ active_days &lt; 15</td>
              </tr>
              <tr>
                <td class="py-1.5 pr-3 font-sans text-slate-900">Steady Eddie</td>
                <td class="py-1.5">catch-all — every other active contributor</td>
              </tr>
            </tbody>
          </table>
          <p class="mt-3 text-justify text-xs text-slate-500">
            Steady Eddie is further tiered by Momentum rank within the cohort —
            <span class="font-medium text-yellow-700">Gold</span> for the top {{ STATIC.steadyEddieGoldPct }}%,
            <span class="font-medium text-slate-500">Silver</span> for the top {{ STATIC.steadyEddieSilverPct }}%
            (excluding Gold), <span class="font-medium text-amber-700">Bronze</span> for the rest. Decay in Momentum
            means devs who go quiet naturally demote.
          </p>
        </section>

        <section>
          <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Current calibration</h3>
          <div class="grid grid-cols-3 gap-x-6 gap-y-1 text-xs">
            <div class="text-slate-700">
              <span class="font-serif italic">α</span> (delete weight) = {{ STATIC.alpha }}
            </div>
            <div class="text-slate-700"><span class="font-mono">FLOOR</span> = {{ STATIC.floor }} lines</div>
            <div class="text-slate-700">
              <span class="font-serif italic">λ</span> half-life = {{ STATIC.halfLifeDays }} days
            </div>
            <div class="text-slate-700">
              <span class="font-serif italic">β</span> (pace exponent) = {{ STATIC.beta }}
            </div>
            <div class="text-slate-700">Consistency window = {{ STATIC.consistencyWindowDays }} days</div>
          </div>
        </section>

        <p class="border-t border-slate-100 pt-4 text-xs text-slate-500">
          Suggest changes in the algorithm to
          <a
            href="mailto:zobayer@tigerit.com?subject=ShipShow%20Score%20%E2%80%94%20algorithm%20suggestion"
            class="font-medium text-blue-600 underline-offset-2 hover:text-blue-800 hover:underline"
            >zobayer@tigerit.com</a
          >.
        </p>
      </div>
    </div>
  </div>
</template>
