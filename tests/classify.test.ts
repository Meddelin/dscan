import { describe, it, expect } from 'vitest';
import type { ComponentProfile } from '../src/pipeline/profile.js';
import { matchNeither } from '../src/classify/neither.js';
import { detectSignals, type SignalContext } from '../src/classify/signals.js';
import { pickLevel } from '../src/classify/levels.js';
import { classifyLocal } from '../src/classify/classify-b.js';

function stubProfile(overrides: Partial<ComponentProfile> = {}): ComponentProfile {
  return {
    repoId: 'r',
    filePath: 'src/Foo.tsx',
    absPath: '/abs/src/Foo.tsx',
    componentName: 'Foo',
    jsxElementCount: 1,
    htmlTags: [],
    propNames: [],
    usesStyled: false,
    beaverImports: [],
    localImports: [],
    passesClassNameToBeaver: false,
    wrapsBeaverWithStyled: false,
    hasBeaverImport: false,
    filesUsedIn: 0,
    usageCount: 0,
    codeSnippet: '',
    codeSnippetTruncated: false,
    ...overrides,
  };
}

const CTX: SignalContext = {
  primitiveNames: new Set(['Button', 'Card', 'Modal']),
  reusableLocalThreshold: 2,
  substantialMarkupThreshold: 5,
};

describe('matchNeither', () => {
  it('flags *Provider', () => {
    expect(matchNeither(stubProfile({ componentName: 'AuthProvider' }))).toEqual({
      code: 'provider-context',
    });
  });
  it('flags *Context and *Gate', () => {
    expect(matchNeither(stubProfile({ componentName: 'ThemeContext' }))?.code).toBe(
      'provider-context',
    );
    expect(matchNeither(stubProfile({ componentName: 'PermissionGate' }))?.code).toBe(
      'provider-context',
    );
  });
  it('flags data-components when markup ≤ 2', () => {
    expect(
      matchNeither(stubProfile({ componentName: 'UserQuery', jsxElementCount: 2 }))
        ?.code,
    ).toBe('data-component');
    // 3 elements → too much markup for a data-component
    expect(
      matchNeither(stubProfile({ componentName: 'UserQuery', jsxElementCount: 3 })),
    ).toBeNull();
  });
  it('flags layout-wrappers when markup ≤ 3', () => {
    expect(
      matchNeither(stubProfile({ componentName: 'AppShell', jsxElementCount: 3 }))
        ?.code,
    ).toBe('layout-wrapper');
    expect(
      matchNeither(stubProfile({ componentName: 'AppShell', jsxElementCount: 4 })),
    ).toBeNull();
  });
  it('does not flag primitive names', () => {
    expect(matchNeither(stubProfile({ componentName: 'Button' }))).toBeNull();
  });
});

describe('detectSignals', () => {
  it('primitive-like-name + substantial-markup on large local primitive', () => {
    const signals = detectSignals(
      stubProfile({ componentName: 'Button', jsxElementCount: 6 }),
      CTX,
    );
    expect(signals).toContain('primitive-like-name');
    expect(signals).toContain('substantial-markup');
  });
  it('wraps-with-customization when className passed to Beaver', () => {
    const signals = detectSignals(
      stubProfile({
        hasBeaverImport: true,
        passesClassNameToBeaver: true,
      }),
      CTX,
    );
    expect(signals).toContain('wraps-with-customization');
  });
  it('standalone-styled requires styled + no Beaver import', () => {
    expect(
      detectSignals(stubProfile({ usesStyled: true, hasBeaverImport: false }), CTX),
    ).toContain('standalone-styled');
    expect(
      detectSignals(stubProfile({ usesStyled: true, hasBeaverImport: true }), CTX),
    ).not.toContain('standalone-styled');
  });
  it('reusable-local fires at threshold', () => {
    expect(
      detectSignals(stubProfile({ filesUsedIn: 2 }), CTX),
    ).toContain('reusable-local');
    expect(
      detectSignals(stubProfile({ filesUsedIn: 1 }), CTX),
    ).not.toContain('reusable-local');
  });
  it('parallel-layer triggers on ui/ directory segment', () => {
    expect(
      detectSignals(stubProfile({ filePath: 'src/shared/ui/Button.tsx' }), CTX),
    ).toContain('parallel-layer');
  });
});

describe('pickLevel', () => {
  it('confirmed requires no-Beaver + primitive + substantial', () => {
    const profile = stubProfile({ hasBeaverImport: false });
    const signals = new Set<ReturnType<typeof detectSignals>[number]>([
      'primitive-like-name',
      'substantial-markup',
    ]);
    expect(pickLevel(profile, signals)).toBe('confirmed');
  });
  it('demotes to likely when reusable-local without substantial markup', () => {
    expect(
      pickLevel(
        stubProfile({ hasBeaverImport: false }),
        new Set(['primitive-like-name', 'reusable-local']),
      ),
    ).toBe('likely');
  });
  it('returns possible when only one weak signal fires', () => {
    expect(
      pickLevel(stubProfile({ hasBeaverImport: false }), new Set(['parallel-layer'])),
    ).toBe('possible');
  });
  it('returns null on empty signal set', () => {
    expect(pickLevel(stubProfile(), new Set())).toBeNull();
  });
});

describe('classifyLocal (orchestrator)', () => {
  it('neither-heuristic wins over shadow signals', () => {
    // Imagine a primitive-named Container — `*Container` maps to neither.
    const res = classifyLocal(
      stubProfile({ componentName: 'ModalContainer', jsxElementCount: 6 }),
      CTX,
    );
    expect(res.bucket).toBe('neither');
    expect(res.classificationSource).toBe('utility-heuristic');
  });

  it('adoption-wrapper when Beaver composition with no customization', () => {
    const res = classifyLocal(
      stubProfile({
        componentName: 'OrderForm',
        hasBeaverImport: true,
        jsxElementCount: 3,
        passesClassNameToBeaver: false,
      }),
      CTX,
    );
    expect(res.bucket).toBe('adoption');
    expect(res.classificationSource).toBe('beaver-composition');
  });

  it('shadow when Beaver + className/style', () => {
    const res = classifyLocal(
      stubProfile({
        componentName: 'BrandButton',
        hasBeaverImport: true,
        passesClassNameToBeaver: true,
      }),
      CTX,
    );
    expect(res.bucket).toBe('shadow');
    expect(res.classificationSource).toBe('wraps-with-customization');
  });

  it('confirmed shadow for primitive + substantial + no Beaver', () => {
    const res = classifyLocal(
      stubProfile({
        componentName: 'Button',
        hasBeaverImport: false,
        jsxElementCount: 7,
      }),
      CTX,
    );
    expect(res.bucket).toBe('shadow');
    expect(res.shadowLevel).toBe('confirmed');
    expect(res.classificationSource).toBe('parallel-local-ui');
  });

  it('default neither when no signals fire', () => {
    const res = classifyLocal(
      stubProfile({ componentName: 'SomeThing', jsxElementCount: 1 }),
      CTX,
    );
    expect(res.bucket).toBe('neither');
  });
});
