/**
 * i18n residue regression test — ensures converted component files contain no
 * hardcoded English UI strings that should have been replaced with t() calls.
 *
 * Strategy (simpler/more reliable than AST parsing):
 *   For each target file, read the source and run the forbidden string through a
 *   line-by-line check.  A line is flagged only when it contains the forbidden
 *   string AND does NOT contain any of the safe-pattern tokens (t(, //, import,
 *   className, data-, aria-, type, interface, Error boundary class names, etc.).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// ── Helpers ────────────────────────────────────────────────────────────────

const COMPONENTS_ROOT = resolve(
  __dirname,
  "../components",
);

/** Resolve a path relative to the components directory. */
function componentPath(...parts: string[]): string {
  return resolve(COMPONENTS_ROOT, ...parts);
}

/**
 * Return the line numbers and content of lines in `source` that contain
 * `needle` but are NOT exempted by any of the `safePatterns`.
 */
function findForbiddenLines(
  source: string,
  needle: string,
  safePatterns: RegExp[],
): Array<{ lineNo: number; content: string }> {
  return source
    .split("\n")
    .map((content, idx) => ({ lineNo: idx + 1, content }))
    .filter(({ content }) => {
      if (!content.includes(needle)) return false;
      // Line is safe if any safe pattern matches
      return !safePatterns.some((p) => p.test(content));
    });
}

// ── Safe-pattern sets ──────────────────────────────────────────────────────

/**
 * Patterns that make a line safe (i.e. the occurrence of the forbidden string
 * on this line is legitimate and should not be flagged).
 *
 * Common safe tokens:
 *   - t("…")   — already translated via i18n call
 *   - //        — single-line comment
 *   - /*        — start of block comment
 *   -  *        — continuation line inside block comment (JSDoc)
 *   - import    — import statement
 *   - className — CSS class name string
 *   - data-     — data attribute
 *   - aria-     — aria attribute
 *   - type / interface / extends / implements — TypeScript type context
 *   - =         — variable / constant assignment (e.g. ErrorBoundary class name)
 *   - role=     — role attribute
 */
const BASE_SAFE: RegExp[] = [
  /\bt\s*\(/,           // t( call
  /\/\//,               // single-line comment
  /\/\*/,               // block comment open
  /^\s+\*/,             // block comment continuation
  /\bimport\b/,         // import statement
  /\bclassName\b/,      // className prop
  /data-/,              // data-* attribute
  /aria-/,              // aria-* attribute
  /\btype\b/,           // TypeScript type keyword
  /\binterface\b/,      // TypeScript interface
  /\bextends\b/,        // TypeScript extends
  /\bimplements\b/,     // TypeScript implements
  /\bclass\b/,          // class declaration (ErrorBoundary extends Component)
  /=\s*["'`]/,          // string assigned to a variable/prop (e.g. error="…")
  /\brole\b/,           // role attribute
  /Translation/,        // react-i18next Translation component import/usage
  /console\./,          // console.error etc (e.g. "[ErrorBoundary]")
];

// ── Files under test ───────────────────────────────────────────────────────

const FILES = [
  // board/*
  componentPath("lens/board/BlastRadius.tsx"),
  componentPath("lens/board/CauseCard.tsx"),
  componentPath("lens/board/ConfidenceCard.tsx"),
  componentPath("lens/board/DiagnosisPending.tsx"),
  componentPath("lens/board/ImmediateAction.tsx"),
  componentPath("lens/board/LensEvidenceEntry.tsx"),
  componentPath("lens/board/LensIncidentBoard.tsx"),
  componentPath("lens/board/OperatorCheck.tsx"),
  componentPath("lens/board/RootCauseHypothesis.tsx"),
  componentPath("lens/board/WhatHappened.tsx"),
  // evidence/*
  componentPath("lens/evidence/ContextBar.tsx"),
  componentPath("lens/evidence/LensEvidenceStudio.tsx"),
  componentPath("lens/evidence/LensEvidenceTabs.tsx"),
  componentPath("lens/evidence/LensLogsView.tsx"),
  componentPath("lens/evidence/LensMetricsView.tsx"),
  componentPath("lens/evidence/LensProofCards.tsx"),
  componentPath("lens/evidence/LensSideRail.tsx"),
  componentPath("lens/evidence/LensTracesView.tsx"),
  componentPath("lens/evidence/QAFrame.tsx"),
  // map/*
  componentPath("lens/map/IncidentStrip.tsx"),
  componentPath("lens/map/MapGraph.tsx"),
  componentPath("lens/map/MapNode.tsx"),
  componentPath("lens/map/MapStateNotice.tsx"),
  componentPath("lens/map/MapView.tsx"),
  componentPath("lens/map/StatsBar.tsx"),
  // top-level lens components
  componentPath("lens/LensShell.tsx"),
  componentPath("lens/LevelHeader.tsx"),
  componentPath("lens/ZoomNav.tsx"),
  // common + root
  componentPath("common/ErrorBoundary.tsx"),
  componentPath("setup-gate.tsx"),
];

// ── Forbidden string definitions ───────────────────────────────────────────

interface ForbiddenEntry {
  /** Human-readable description of what should have been converted */
  description: string;
  /** The exact string that must not appear as raw UI text */
  needle: string;
  /**
   * Extra safe patterns specific to this entry, merged with BASE_SAFE.
   * Use when the needle legitimately appears in non-UI contexts unique to
   * this string.
   */
  extraSafe?: RegExp[];
}

const FORBIDDEN: ForbiddenEntry[] = [
  {
    description: '"Loading" as raw JSX text (should be t("…loading…"))',
    needle: "Loading",
    extraSafe: [
      /isLoading/,       // TanStack Query property
      /isLoading\b/,
      /\.isLoading/,
      /isLoading\s*[=|&|?]/,
      /"loading"/,       // string literal used as state value (e.g. "loading" state)
      /\bloading\b/,     // lowercase — only uppercase "Loading" is the needle,
                         // but guard against "isLoading" false-positives at word boundary
      /lens-board-loading/, // CSS class name
      /lens-ev-loading/,    // CSS class name
      /level-placeholder/,  // Suspense fallback class
      /lazy\(/,             // React.lazy() call
    ],
  },
  {
    description: '"Error" as raw JSX text (should be t("…error…"))',
    needle: "Error",
    extraSafe: [
      /\bError\b.*extends/,           // class ErrorBoundary extends Component
      /\bErrorBoundary\b/,            // component name reference
      /\bErrorInfo\b/,                // React type
      /\bApiError\b/,                 // custom error class
      /instanceof\s+Error/,           // error instanceof check
      /new\s+Error/,                  // new Error(...)
      /error\s*instanceof/,
      /:\s*Error\b/,                  // TypeScript type annotation
      /Error\s*\|/,                   // union type
      /\|\s*Error/,                   // union type
      /error-boundary/,               // CSS class
      /lens-board-error/,             // CSS class
      /lens-ev-error/,                // CSS class
      /isError/,                      // TanStack Query
      /\.isError/,
      /onError/,                      // callback
      /setSubmitError/,               // state setter
      /submitError/,                  // prop/state variable
      /errorMsg/,                     // state variable
      /setErrorMsg/,
      /"error"/,                      // state string literal
      /\berror\b/,                    // lowercase error variable
      /console\.error/,               // console.error call
      /[a-z]Error/,                   // camelCase identifier e.g. traceErrors, hasError, getDerivedStateFromError
    ],
  },
  {
    description: '"Evidence Studio" as raw JSX text (should be t("header.evidenceStudio") or t("evidence.studioLabel"))',
    needle: "Evidence Studio",
    extraSafe: [
      // Block-comment / JSDoc lines are already covered by BASE_SAFE
      // but the comment in LevelHeader says `back + "Evidence Studio"` — covered by /* and * patterns
    ],
  },
  {
    description: '"Immediate Action" as raw JSX text (should be t("board.immediateAction.title"))',
    needle: "Immediate Action",
  },
  {
    description: '"Blast Radius" as raw JSX text (should be t("board.blastRadius.title"))',
    needle: "Blast Radius",
  },
  {
    description: '"Causal Chain" as raw JSX text (should be t("board.causalChain.title"))',
    needle: "Causal Chain",
  },
  {
    description: '"Operator Check" as raw JSX text (should be t("board.operatorCheck.title"))',
    needle: "Operator Check",
  },
  {
    description: '"Root Cause" as raw JSX text (should be t("board.rootCause.*"))',
    needle: "Root Cause",
  },
  {
    description: '"Confidence" as a standalone visible label (should be t("board.confidence.*"))',
    needle: '"Confidence"',
    // Match only when the needle appears as a standalone quoted string literal
    // in JSX, not in t() keys or type names.  The needle is already quoted, so
    // BASE_SAFE covers t( and comment contexts.
  },
];

// ── Tests ──────────────────────────────────────────────────────────────────

describe("i18n residue — no hardcoded English UI strings in converted components", () => {
  for (const entry of FORBIDDEN) {
    it(`${entry.description}`, () => {
      const safePatterns = [...BASE_SAFE, ...(entry.extraSafe ?? [])];
      const violations: string[] = [];

      for (const filePath of FILES) {
        let source: string;
        try {
          source = readFileSync(filePath, "utf-8");
        } catch {
          // File not found — skip; i18n-completeness tests will catch missing files
          continue;
        }

        const hits = findForbiddenLines(source, entry.needle, safePatterns);
        for (const { lineNo, content } of hits) {
          violations.push(`  ${filePath.replace(COMPONENTS_ROOT + "/", "")}:${lineNo}  ${content.trim()}`);
        }
      }

      if (violations.length > 0) {
        throw new Error(
          `Hardcoded English string "${entry.needle}" found in ${violations.length} line(s):\n${violations.join("\n")}\n\nReplace with the appropriate t() call.`,
        );
      }
    });
  }
});
