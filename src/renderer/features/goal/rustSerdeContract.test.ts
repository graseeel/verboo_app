/**
 * G-C12-4: Rust ↔ TypeScript serde contract test.
 *
 * The Rust side declares structs with `#[serde(rename_all = "camelCase")]`.
 * serde serializes snake_case Rust fields as camelCase JSON keys. The TS
 * side must declare the SAME camelCase keys — if it declares snake_case,
 * tsc validates all reads against a contract that LIES about what the
 * Rust side sends, and the `?? 0` / `?? undefined` coalescing silently
 * turns every read into zero/undefined in production. Tests pass, the
 * app ships, the feature is broken. This is exactly what happened with
 * TokenUsage: the type declared `input_tokens`, the Rust sent
 * `inputTokens`, and the goal token accumulator read zero for every
 * turn.
 *
 * This test reads the Rust source file AND the TS source file at
 * runtime, extracts every struct marked with `#[serde(rename_all =
 * "camelCase")]` and its `pub` fields, computes the expected camelCase
 * key for each field, and asserts that the TS file declares the SAME
 * camelCase key for the corresponding type.
 *
 * WHY SOURCE-TEXT COMPARISON (not runtime introspection):
 *   TypeScript types are erased at compile time. A `import * as Types`
 *   against a module that only exports types returns an empty object at
 *   runtime. The previous version of this test tried to introspect
 *   `Types.TokenUsage` and asserted `expect(tsType).toBeDefined()` —
 *   which always failed because types are not values.
 *
 *   The fix is to read the .ts file as text and search for the
 *   expected camelCase key inside the type declaration. This is the
 *   same approach used by goalState.contract.test.ts (which reads
 *   types.rs to pin the Rust u32/u64 limits and runs assertions on
 *   the parsed structure).
 *
 * WHY THIS CATCHES FUTURE FIELDS:
 *   - The test parses the Rust source, so adding a new field to a
 *     rename_all struct automatically adds it to the test's expected
 *     set. If the TS type doesn't have the camelCase key, the test
 *     fails with the field name in the message.
 *   - The test does NOT hardcode the field list — it derives the
 *     expectation from the Rust source. A new field can't slip through
 *     by being "not in the test yet".
 *   - The test covers EVERY rename_all struct the Rust side declares
 *     that has a TS counterpart (looked up by name in the mapping
 *     table), not just TokenUsage.
 *
 * SERDE RENAME RULE (camelCase):
 *   input_tokens       → inputTokens
 *   output_tokens      → outputTokens
 *   cache_creation_input_tokens → cacheCreationInputTokens
 *   a_single_word      → aSingleWord
 *   id                 → id (no underscore, UNCHANGED)
 *   usage              → usage (no underscore, UNCHANGED)
 *   status             → status (no underscore, UNCHANGED)
 *
 *   Single-word fields are NOT transformed by serde's rename_all.
 *   The assertion must split: multi-word fields must CHANGE; single-
 *   word fields must stay IDENTICAL. The previous version asserted
 *   `expected !== field` for every field, which is wrong for
 *   single-word fields like `usage` or `errors`.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const RUST_TYPES_PATH = resolve(
  __dirname,
  '../../../../src-tauri/src/models/types.rs',
)

const RUST_LIB_PATH = resolve(
  __dirname,
  '../../../../src-tauri/src/lib.rs',
)

const TS_TYPES_PATH = resolve(
  __dirname,
  '../../../shared/types.ts',
)

/**
 * Extract every struct in the Rust source that is marked with
 * `#[serde(rename_all = "camelCase")]`, returning for each struct the
 * list of `pub field: Type` declarations (field name only).
 *
 * The parser is intentionally simple — it scans line by line, tracks
 * the most recent `#[serde(rename_all = "camelCase")]` attribute, and
 * when it sees `pub struct Name {` it collects subsequent `pub field:
 * Type,` lines until the closing `}`.
 */
function extractCamelCaseStructs(rustSource: string): Array<{
  structName: string
  fields: string[]
}> {
  const lines = rustSource.split('\n')
  const results: Array<{ structName: string; fields: string[] }> = []

  let pendingCamelCase = false
  let inStruct: string | null = null
  let structFields: string[] = []

  for (const raw of lines) {
    const line = raw.trim()

    if (line === '#[serde(rename_all = "camelCase")]') {
      pendingCamelCase = true
      continue
    }
    // Other attributes (e.g. #[derive(...)]) appear between the rename
    // and the struct — don't reset the flag.
    if (line.startsWith('#[') && !line.includes('rename_all')) {
      continue
    }

    // G-C15-FIX: accept `struct` with OR without `pub`. lib.rs
    // declares `struct EvaluationResult` (no pub — it's a private
    // helper), while types.rs uses `pub struct`. The casing contract
    // only needs the struct name and its fields, not visibility.
    const structMatch = line.match(/^(?:pub\s+)?struct (\w+)\s*\{/)
    if (structMatch && pendingCamelCase) {
      inStruct = structMatch[1]
      structFields = []
      pendingCamelCase = false
      continue
    }
    if (structMatch) {
      pendingCamelCase = false
      inStruct = null
      continue
    }

    if (inStruct) {
      if (line === '}') {
        results.push({ structName: inStruct, fields: structFields })
        inStruct = null
        structFields = []
        continue
      }
      // G-C15-FIX: accept `field:` with or without `pub`. lib.rs
      // fields are private (no pub); types.rs fields are public.
      // The contract only needs the field name, not visibility.
      // Skip doc comments (`///`) and regular comments (`//`) so they
      // don't get matched as fields.
      if (line.startsWith('//')) continue
      const fieldMatch = line.match(/^(?:pub\s+)?(\w+)\s*:/)
      if (fieldMatch) {
        structFields.push(fieldMatch[1])
      }
    }
  }

  return results
}

/**
 * Convert a snake_case Rust field name to the camelCase key serde
 * produces under `rename_all = "camelCase"`. Single-word fields
 * (no underscore) are returned unchanged — serde does not rename them.
 */
function rustSnakeToCamelCase(field: string): string {
  if (!field.includes('_')) return field
  return field.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase())
}

/**
 * Extract the field names declared in a TS type/interface body.
 * Reads the .ts file as text and finds the matching `export type X =
 * { ... }` or `export interface X { ... }` block, then collects every
 * `fieldName:` or `fieldName?:` token inside it.
 *
 * This is a search-and-parse, not a type-aware analysis — it reads
 * the syntax of the declaration. It works because field declarations
 * in TS types follow a small set of patterns and we only need the
 * names, not the types.
 */
function extractTsTypeFields(tsSource: string, typeName: string): string[] {
  // Find the opening of the type declaration.
  const patterns = [
    new RegExp(`export type\\s+${typeName}\\s*=\\s*\\{([^}]*)\\}`),
    new RegExp(`export interface\\s+${typeName}\\s*\\{([^}]*)\\}`),
  ]
  for (const re of patterns) {
    const m = tsSource.match(re)
    if (m) {
      const body = m[1]
      // Match `fieldName:` or `fieldName?:` at the start of a token.
      const fields: string[] = []
      for (const fieldMatch of body.matchAll(/(?:^|\n)\s*(\w+)\s*\??:/g)) {
        fields.push(fieldMatch[1])
      }
      return fields
    }
  }
  return []
}

/**
 * Map of Rust struct names to their TS counterpart names in
 * shared/types.ts. When the Rust side adds a new rename_all struct
 * that crosses the Tauri boundary, add the mapping here. The test
 * will fail if the TS type is missing or has the wrong key shape.
 *
 * G-C12: TokenUsage and AgentResultSnapshot are the two confirmed
 * boundary structs. GoalState is covered by goalState.contract.test.ts
 * (numeric limits, not key shape) — listed here too because it has
 * rename_all and a TS counterpart, so the key-shape contract applies.
 */
const RUST_TO_TS_NAME: Record<string, string> = {
  TokenUsage: 'TokenUsage',
  AgentResultSnapshot: 'AgentResultSnapshot',
  GoalState: 'GoalState',
  ContextUsageSnapshot: 'ContextUsageSnapshot',
  // A1: payload struct of the `login:event` channel (types.rs:590).
  LoginEvent: 'LoginEvent',
}

describe('G-C12-4: Rust serde camelCase ↔ TS type contract (source-text)', () => {
  const rustSource = readFileSync(RUST_TYPES_PATH, 'utf-8')
  const tsSource = readFileSync(TS_TYPES_PATH, 'utf-8')
  const structs = extractCamelCaseStructs(rustSource)

  it('the Rust source file exists and parses at least one rename_all struct', () => {
    expect(structs.length).toBeGreaterThan(0)
    expect(structs.some(s => s.structName === 'TokenUsage')).toBe(true)
  })

  // ─── Per-struct, per-field contract checks ────────────────────
  for (const { structName, fields } of structs) {
    const tsName = RUST_TO_TS_NAME[structName]
    if (!tsName) continue // out of scope: no TS counterpart

    describe(`${structName} → ${tsName}`, () => {
      const tsFields = extractTsTypeFields(tsSource, tsName)

      it('has a TS type declaration with parseable fields', () => {
        // The TS type must exist and be parseable. If the type is
        // missing or the extraction found nothing, the test will
        // surface that as a clear failure rather than a confusing
        // "no assertions ran" pass.
        expect(tsFields.length).toBeGreaterThan(0)
      })

      for (const field of fields) {
        const expectedKey = rustSnakeToCamelCase(field)
        const isMultiWord = field.includes('_')

        it(`field "${field}" → TS key "${expectedKey}" (${isMultiWord ? 'camelCase' : 'single-word, unchanged'})`, () => {
          // The contract: serde rename_all = "camelCase" in Rust
          // produces the expectedKey in JSON. The TS type must use
          // that exact key as a field name.
          expect(tsFields).toContain(expectedKey)

          // Serde rename behavior:
          //   - Multi-word snake_case fields MUST transform.
          //   - Single-word fields MUST stay identical.
          if (isMultiWord) {
            // The TS type must NOT keep the snake_case form — that
            // is the G-C12 regression. If anyone reverts the TS
            // type to snake_case, this assertion fails.
            expect(tsFields).not.toContain(field)
          } else {
            // Single-word field: the key is the same on both sides.
            // The expected key (which equals the field) must be
            // present (already asserted above), and there is no
            // "wrong form" to check against.
            expect(expectedKey).toBe(field)
          }
        })
      }
    })
  }

  // ─── The regression that motivated this test ───────────────────
  it('G-C12 regression: TokenUsage fields are camelCase in TS, NOT snake_case', () => {
    // The original bug: TokenUsage in TS declared input_tokens (snake),
    // but Rust sent inputTokens (camel). The renderer read undefined,
    // coalesced to 0, and the goal token counter always reported zero.
    //
    // This test pins the fix at the source-text level: every
    // TokenUsage field in the Rust source maps to a camelCase key,
    // and the TS type must declare that camelCase key. It also
    // asserts the negative space — the snake_case form must NOT be
    // present, so a reversion to the bug shape is caught.
    const tokenUsage = structs.find(s => s.structName === 'TokenUsage')
    expect(tokenUsage).toBeDefined()
    const expectedKeys = tokenUsage!.fields.map(rustSnakeToCamelCase)
    const tsFields = extractTsTypeFields(tsSource, 'TokenUsage')

    // Every expected camelCase key must be present in the TS type.
    for (const key of expectedKeys) {
      expect(tsFields, `TokenUsage in TS must have camelCase key "${key}"`).toContain(key)
    }

    // The snake_case form must NOT be present. This is the bug
    // shape — if anyone reverts the TS type to snake_case, this
    // catches them.
    const snakeCaseKeys = tokenUsage!.fields.filter(f => f.includes('_'))
    for (const snake of snakeCaseKeys) {
      expect(
        tsFields,
        `TokenUsage in TS must NOT have snake_case key "${snake}" — serde rename_all camelCase sends "${rustSnakeToCamelCase(snake)}"`,
      ).not.toContain(snake)
    }
  })
})

// ─── G-C15-FIX: PLACEMENT contract (sibling vs nested) ──────────
//
// The casing contract above catches field-NAME mismatches (snake_case
// vs camelCase). But G-C15-FIX revealed a second defect class in the
// same family: a field can have the RIGHT name but live in the WRONG
// struct. The Rust boundary struct `EvaluationResult` (lib.rs:40)
// declares `evaluation`, `user_message`, and `evaluator_usage` as
// SIBLINGS at the top level. The previous G-C15-TS adendo wrongly
// placed `evaluatorUsage` INSIDE `GoalEvaluationResult` (the TS
// counterpart of the NESTED `evaluation` field, not the envelope).
// The renderer read `evaluation.evaluatorUsage` — a key that never
// existed — and the evaluator's tokens never reached the usage line.
//
// The casing test passed because the NAME was right (`evaluatorUsage`
// existed in the TS type). It missed that the field lived in the
// WRONG type. This block extends the contract to check PLACEMENT:
// for each Rust boundary struct in lib.rs that has a TS ENVELOPE
// counterpart, every Rust field must be a TOP-LEVEL key in the TS
// envelope — NOT nested inside a sub-type.

describe('G-C15-FIX: Rust serde PLACEMENT ↔ TS envelope contract (sibling, not nested)', () => {
  // lib.rs is the Tauri command boundary — structs here are the JSON
  // shapes that cross the invoke<T>() frontier. If a field is a
  // sibling in the Rust struct, the TS envelope must declare it as a
  // sibling too (not nested inside a sub-field).
  const rustLibSource = readFileSync(RUST_LIB_PATH, 'utf-8')
  const tsSource = readFileSync(TS_TYPES_PATH, 'utf-8')
  const libStructs = extractCamelCaseStructs(rustLibSource)

  it('the Rust lib.rs source parses at least one rename_all struct', () => {
    expect(libStructs.length).toBeGreaterThan(0)
  })

  // Map of Rust boundary struct names (in lib.rs) to their TS ENVELOPE
  // counterparts in shared/types.ts. An envelope is the TS type that
  // mirrors the TOP-LEVEL shape of the Rust boundary struct — its
  // fields are SIBLINGS, not nested.
  //
  // G-C15-FIX: EvaluationResult is the boundary struct for the
  // `evaluate_goal` command. Its TS counterpart is
  // GoalEvaluationEnvelope (NOT GoalEvaluationResult, which mirrors
  // the NESTED `evaluation` sub-struct).
  const RUST_LIB_TO_TS_ENVELOPE: Record<string, string> = {
    EvaluationResult: 'GoalEvaluationEnvelope',
  }

  for (const { structName, fields } of libStructs) {
    const tsEnvelopeName = RUST_LIB_TO_TS_ENVELOPE[structName]
    if (!tsEnvelopeName) continue

    describe(`${structName} → ${tsEnvelopeName} (placement)`, () => {
      const tsEnvelopeFields = extractTsTypeFields(tsSource, tsEnvelopeName)

      it('has a TS envelope type declaration with parseable fields', () => {
        expect(tsEnvelopeFields.length).toBeGreaterThan(0)
      })

      for (const field of fields) {
        const expectedKey = rustSnakeToCamelCase(field)

        it(`field "${field}" is a TOP-LEVEL sibling in ${tsEnvelopeName} (not nested)`, () => {
          // The contract: every field of the Rust boundary struct
          // must be a top-level key in the TS envelope. If the field
          // is wrongly placed INSIDE a sub-type (e.g.,
          // `evaluatorUsage` inside `GoalEvaluationResult` instead
          // of `GoalEvaluationEnvelope`), this assertion fails —
          // the key is absent from the envelope's top level.
          expect(
            tsEnvelopeFields,
            `Rust field "${field}" must be a top-level key in ${tsEnvelopeName} (sibling of evaluation), not nested inside a sub-type. See G-C15-FIX: evaluatorUsage was wrongly placed inside GoalEvaluationResult, but the Rust struct declares it as a sibling of evaluation.`,
          ).toContain(expectedKey)
        })
      }
    })
  }

  // ─── The regression that motivated this PLACEMENT contract ────
  it('G-C15-FIX regression: evaluatorUsage is a SIBLING of evaluation in GoalEvaluationEnvelope, NOT inside GoalEvaluationResult', () => {
    // The original bug: evaluatorUsage was declared inside
    // GoalEvaluationResult (the TS counterpart of the NESTED
    // evaluation sub-struct). The renderer read
    // evaluation.evaluatorUsage — a key that never existed in the
    // JSON — and the evaluator's tokens never reached the usage line.
    //
    // This test pins the fix: evaluatorUsage is a top-level key in
    // GoalEvaluationEnvelope (sibling of evaluation), and is NOT a
    // key in GoalEvaluationResult (the nested sub-type).
    const envelopeFields = extractTsTypeFields(tsSource, 'GoalEvaluationEnvelope')
    const evaluationFields = extractTsTypeFields(tsSource, 'GoalEvaluationResult')

    expect(envelopeFields).toContain('evaluatorUsage')
    expect(
      evaluationFields,
      'evaluatorUsage must NOT be inside GoalEvaluationResult — it is a sibling of evaluation in GoalEvaluationEnvelope (Rust lib.rs:40 EvaluationResult)',
    ).not.toContain('evaluatorUsage')
  })
})

// ─── A1: ENUM casing contract (lowercase, NOT camelCase) ────────
//
// The casing contract above covers structs marked rename_all =
// "camelCase". A1 introduced a trap in the SAME type family: the enum
// `LoginEventKind` (types.rs:608) uses rename_all = "lowercase" — a
// DIFFERENT serde attribute. The wire values are the lowercase strings
// "url" | "complete" | "error". A TS union declared as
// 'Url' | 'Complete' | 'Error' would compile and never match at
// runtime — the renderer would ignore every login:event, the exact
// defect class of snake_case TokenUsage, now on ENUM VARIANT CASING.
//
// This block parses the Rust enum marked rename_all = "lowercase",
// derives the expected wire values from the variant names, and asserts
// the TS union declares exactly those lowercase literals — and NOT
// their capitalized forms.

/**
 * Extract the variants of every Rust enum marked with
 * `#[serde(rename_all = "lowercase")]`. Mirrors the struct parser
 * above: scan lines, track the attribute, collect `Variant,` lines
 * until the closing `}`.
 */
function extractLowercaseEnums(rustSource: string): Array<{
  enumName: string
  variants: string[]
}> {
  const lines = rustSource.split('\n')
  const results: Array<{ enumName: string; variants: string[] }> = []

  let pendingLowercase = false
  let inEnum: string | null = null
  let variants: string[] = []

  for (const raw of lines) {
    const line = raw.trim()

    if (line === '#[serde(rename_all = "lowercase")]') {
      pendingLowercase = true
      continue
    }
    if (line.startsWith('#[') && !line.includes('rename_all')) {
      continue
    }

    const enumMatch = line.match(/^(?:pub\s+)?enum (\w+)\s*\{/)
    if (enumMatch && pendingLowercase) {
      inEnum = enumMatch[1]
      variants = []
      pendingLowercase = false
      continue
    }
    if (enumMatch) {
      pendingLowercase = false
      inEnum = null
      continue
    }

    if (inEnum) {
      if (line === '}') {
        results.push({ enumName: inEnum, variants })
        inEnum = null
        variants = []
        continue
      }
      if (line.startsWith('//')) continue
      // Unit variants: `Url,` or `Url` (last line may omit the comma).
      const variantMatch = line.match(/^(\w+),?$/)
      if (variantMatch) {
        variants.push(variantMatch[1])
      }
    }
  }

  return results
}

describe('A1: Rust enum lowercase ↔ TS union contract (LoginEventKind)', () => {
  const rustSource = readFileSync(RUST_TYPES_PATH, 'utf-8')
  const tsSource = readFileSync(TS_TYPES_PATH, 'utf-8')
  const enums = extractLowercaseEnums(rustSource)

  it('the Rust source parses at least one rename_all = "lowercase" enum', () => {
    expect(enums.length).toBeGreaterThan(0)
    expect(enums.some(e => e.enumName === 'LoginEventKind')).toBe(true)
  })

  for (const { enumName, variants } of enums) {
    if (enumName !== 'LoginEventKind') continue // out of scope: no TS counterpart

    describe(`${enumName} → TS union`, () => {
      // The TS union declaration line: `export type LoginEventKind = ...`
      const unionMatch = tsSource.match(new RegExp(`export type ${enumName}\\s*=\\s*([^\\n]+)`))
      const unionBody = unionMatch?.[1] ?? ''

      it('has a TS union declaration', () => {
        expect(unionMatch, `TS must declare export type ${enumName}`).not.toBeNull()
      })

      for (const variant of variants) {
        const expectedWireValue = variant.toLowerCase()

        it(`variant "${variant}" → wire value "${expectedWireValue}" (lowercase)`, () => {
          // serde rename_all = "lowercase" lowercases the whole variant
          // name (Url → "url"). The TS union must contain the lowercase
          // literal…
          expect(
            unionBody,
            `${enumName} in TS must declare '${expectedWireValue}' — the Rust enum uses rename_all = "lowercase"`,
          ).toContain(`'${expectedWireValue}'`)
          // …and must NOT declare the capitalized variant name — that
          // would compile and silently never match at runtime.
          expect(
            unionBody,
            `${enumName} in TS must NOT declare '${variant}' — rename_all = "lowercase" sends '${expectedWireValue}'`,
          ).not.toContain(`'${variant}'`)
        })
      }
    })
  }
})

// ─── D-D: ENUM casing contract (camelCase — GoalReasonId) ───────────
//
// The A1 block above covers the lowercase enum trap. GoalReasonId is
// the OTHER casing in the same file: rename_all = "camelCase"
// (types.rs:420). D-D added the TaskImpossible variant on the Rust
// side; a TS union missing the camelCase literal would compile and
// silently fall through every consumer — exactly how the taskImpossible
// verdict originally had ZERO consumers (the 10th produced-but-
// unconsumed defect, caught before field). This block derives the
// expected wire values from the Rust source and asserts the TS union
// declares every one of them, so the enum can NEVER diverge again.
// Direction: every RUST variant must exist in TS. TS-only members
// (userPaused, userCancelled, goalError — set by the FE itself) are
// legitimate and documented in types.ts.

/** Extract the variants of every Rust enum marked with
 * `#[serde(rename_all = "camelCase")]`. Mirrors extractLowercaseEnums
 * above, parameterized only by the serde attribute line. */
function extractCamelCaseEnums(rustSource: string): Array<{
  enumName: string
  variants: string[]
}> {
  const lines = rustSource.split('\n')
  const results: Array<{ enumName: string; variants: string[] }> = []

  let pendingCamelCase = false
  let inEnum: string | null = null
  let variants: string[] = []

  for (const raw of lines) {
    const line = raw.trim()

    if (line === '#[serde(rename_all = "camelCase")]') {
      pendingCamelCase = true
      continue
    }
    if (line.startsWith('#[') && !line.includes('rename_all')) {
      continue
    }

    const enumMatch = line.match(/^(?:pub\s+)?enum (\w+)\s*\{/)
    if (enumMatch && pendingCamelCase) {
      inEnum = enumMatch[1]
      variants = []
      pendingCamelCase = false
      continue
    }
    if (enumMatch) {
      pendingCamelCase = false
      inEnum = null
      continue
    }

    if (inEnum) {
      if (line === '}') {
        results.push({ enumName: inEnum, variants })
        inEnum = null
        variants = []
        continue
      }
      if (line.startsWith('//')) continue
      const variantMatch = line.match(/^(\w+),?$/)
      if (variantMatch) {
        variants.push(variantMatch[1])
      }
    }
  }

  return results
}

describe('D-D: Rust enum camelCase ↔ TS union contract (GoalReasonId)', () => {
  const rustSource = readFileSync(RUST_TYPES_PATH, 'utf-8')
  const tsSource = readFileSync(TS_TYPES_PATH, 'utf-8')
  const enums = extractCamelCaseEnums(rustSource)

  it('the Rust source parses the GoalReasonId enum', () => {
    expect(enums.some(e => e.enumName === 'GoalReasonId')).toBe(true)
  })

  for (const { enumName, variants } of enums) {
    if (enumName !== 'GoalReasonId') continue // out of scope: only this enum has a TS union to pin

    describe(`${enumName} → TS union`, () => {
      // The TS union is MULTILINE (`export type GoalReasonId =\n  | 'x'…`),
      // unlike the single-line LoginEventKind — capture up to the blank
      // line that ends the declaration.
      const unionMatch = tsSource.match(/export type GoalReasonId\s*=\s*([\s\S]*?)\n\s*\n/)
      const unionBody = unionMatch?.[1] ?? ''

      it('has a TS union declaration', () => {
        expect(unionMatch, 'TS must declare export type GoalReasonId').not.toBeNull()
      })

      for (const variant of variants) {
        // serde rename_all = "camelCase": PascalCase variant → camelCase
        // wire value (TaskImpossible → "taskImpossible").
        const expectedWireValue = variant[0].toLowerCase() + variant.slice(1)

        it(`variant "${variant}" → wire value "${expectedWireValue}" declared in TS`, () => {
          expect(
            unionBody,
            `GoalReasonId in TS must declare '${expectedWireValue}' — the Rust enum (rename_all = "camelCase") sends it and EVERY consumer must be able to match it`,
          ).toContain(`'${expectedWireValue}'`)
          // …and must NOT declare the PascalCase variant name — that
          // would compile and silently never match at runtime.
          expect(
            unionBody,
            `GoalReasonId in TS must NOT declare '${variant}' — rename_all = "camelCase" sends '${expectedWireValue}'`,
          ).not.toContain(`'${variant}'`)
        })
      }
    })
  }
})
