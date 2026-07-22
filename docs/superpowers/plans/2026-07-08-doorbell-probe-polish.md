# Doorbell and Probe Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the unsupported door-open doorbell trigger and make the food-probe accessory singular while cleaning up legacy plural accessories.

**Architecture:** Keep the changes in existing boundaries: `protocol.ts` owns normalized config shape, `platform.ts` owns accessory UUID/name lifecycle, schema/UI/README expose user-facing config. Add protocol and platform tests so behavior is covered without depending on a real Homebridge runtime.

**Tech Stack:** TypeScript, Homebridge plugin API types, Vitest.

---

## Task 1: Remove Unsupported Door-Open Trigger

**Files:**
- Modify: `src/protocol.ts`
- Modify: `src/protocol.test.ts`
- Modify: `config.schema.json`
- Modify: `homebridge-ui/public/index.html`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-08-june-expanded-homekit-features-design.md`

- [ ] **Step 1: Write failing protocol tests**

In `src/protocol.test.ts`, change expected doorbell trigger objects so they only contain `done` and `ready`, and add an assertion that an input `doorOpen` value is ignored.

- [ ] **Step 2: Run protocol tests to verify failure**

Run: `npm test -- src/protocol.test.ts`
Expected: FAIL because `normalizeOvenConfig` still returns `doorOpen`.

- [ ] **Step 3: Remove `doorOpen` from normalized config**

In `src/protocol.ts`, change `JuneDoorbellConfig.triggers` to `{ done: boolean; ready: boolean }` and remove the `doorOpen` default/pass-through line.

- [ ] **Step 4: Remove user-facing config entries**

Remove `doorOpen` from `config.schema.json` properties and form list. Remove stale docs language that describes door-open as pending or tentative.

- [ ] **Step 5: Run protocol tests**

Run: `npm test -- src/protocol.test.ts`
Expected: PASS.

## Task 2: Singular Probe Accessory and Legacy Cleanup

**Files:**
- Modify: `src/platform.ts`
- Create: `src/platform.test.ts`

- [ ] **Step 1: Write failing platform tests**

Create `src/platform.test.ts` with fake Homebridge API classes. Test that enabling `probeSensors` registers an accessory named `Kitchen Probe` for an oven named `Kitchen`, and that a cached legacy UUID generated from `ovenId:probes` is unregistered.

- [ ] **Step 2: Run platform tests to verify failure**

Run: `npm test -- src/platform.test.ts`
Expected: FAIL because current code registers `Kitchen Probes` and treats `ovenId:probes` as the current wanted UUID.

- [ ] **Step 3: Rename platform kind and display name**

In `src/platform.ts`, change the accessory kind from `probes` to `probe`, bind the accessory with `${oven.name || 'June'} Probe`, and instantiate `JuneProbeSensorAccessory` for `kind === 'probe'`.

- [ ] **Step 4: Add legacy cleanup**

In `src/platform.ts`, ensure the previous UUID generated from `${client.config.ovenId}:probes` is not marked wanted and is unregistered by the existing stale cleanup path.

- [ ] **Step 5: Run platform tests**

Run: `npm test -- src/platform.test.ts`
Expected: PASS.

## Task 3: Full Verification

**Files:**
- No new files beyond Tasks 1-2.

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: all test files pass.

- [ ] **Step 2: Run lint/typecheck**

Run: `npm run lint`
Expected: TypeScript exits 0.

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: TypeScript emits `dist` successfully.

- [ ] **Step 4: Commit and push**

Commit focused changes and push to `feature/expanded-homekit-features`.
