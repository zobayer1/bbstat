import { describe, it, expect } from 'vitest';
import { buildMatcher, validatePatterns } from './diff-stats-filter.js';

describe('buildMatcher', () => {
  it('returns always-false when no patterns are configured', () => {
    const m = buildMatcher([]);
    expect(m('foo.png')).toBe(false);
    expect(m('package-lock.json')).toBe(false);
  });

  it('matches bare extension globs at any depth (basename mode)', () => {
    const m = buildMatcher(['*.png', '*.jpg']);
    expect(m('logo.png')).toBe(true);
    expect(m('assets/img/logo.png')).toBe(true);
    expect(m('deep/path/photo.jpg')).toBe(true);
    expect(m('src/index.ts')).toBe(false);
  });

  it('matches explicit path globs', () => {
    const m = buildMatcher(['dist/**', '**/pnpm-lock.yaml']);
    expect(m('dist/main.js')).toBe(true);
    expect(m('dist/nested/chunk.js')).toBe(true);
    expect(m('pnpm-lock.yaml')).toBe(true);
    expect(m('packages/foo/pnpm-lock.yaml')).toBe(true);
    expect(m('src/dist-helper.ts')).toBe(false);
  });

  it('matches dot-files / dot-dirs by default (dot: true)', () => {
    const m = buildMatcher(['*.env', '.github/**']);
    expect(m('.env')).toBe(true);
    expect(m('config/.env')).toBe(true);
    expect(m('.github/workflows/ci.yml')).toBe(true);
  });

  it('matches Unity-style asset paths', () => {
    const m = buildMatcher(['Assets/**', '*.meta']);
    expect(m('Assets/Scenes/Main.unity')).toBe(true);
    expect(m('Assets/Prefabs/Player.prefab.meta')).toBe(true);
    expect(m('Source/Game.cs')).toBe(false);
  });
});

describe('validatePatterns', () => {
  it('accepts every well-formed pattern', () => {
    expect(validatePatterns(['*.png', '**/pnpm-lock.yaml', 'dist/**', 'Assets/**/*.meta', '!src/keep.png'])).toBeNull();
  });

  it('rejects empty strings', () => {
    expect(validatePatterns(['*.png', ''])).toMatchObject({ pattern: '', message: expect.any(String) });
  });

  it('rejects non-string entries', () => {
    expect(validatePatterns(['*.png', 42 as unknown as string])).toMatchObject({ pattern: '42' });
  });
});
