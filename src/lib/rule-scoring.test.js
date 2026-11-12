import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRuleCompliance } from './rule-scoring.js';

describe('scoreRuleCompliance — referenced signal', () => {
  it('scores 1.0 when rule ID in referenced_context', () => {
    const events = [
      { tool: 'Read', referenced_context: ['API-001'], files_touched: ['src/api.ts'] },
    ];
    const rules = [{ id: 'API-001', text: 'REST conventions' }];
    const scores = scoreRuleCompliance(events, rules);
    assert.equal(scores['API-001'].score, 1.0);
    assert.equal(scores['API-001'].evidence, 'referenced');
  });

  it('scores 0.0 when rule never referenced', () => {
    const events = [
      { tool: 'Read', referenced_context: [], files_touched: ['src/api.ts'] },
    ];
    const rules = [{ id: 'API-001', text: 'REST conventions' }];
    const scores = scoreRuleCompliance(events, rules);
    assert.equal(scores['API-001'].score, 0.0);
    assert.equal(scores['API-001'].evidence, 'ignored');
  });
});

describe('scoreRuleCompliance — sibling_file_touched signal', () => {
  it('scores 0.5 when sibling test file is touched', () => {
    const events = [
      { tool: 'Write', referenced_context: [], files_touched: ['src/auth.ts'] },
      { tool: 'Write', referenced_context: [], files_touched: ['src/auth.test.ts'] },
    ];
    const rules = [{
      id: 'TEST-001',
      text: 'Unit tests for all business logic',
      behavioral_signals: [
        {
          trigger: { file_glob: 'src/**/*.ts', tool: ['Write', 'Edit'] },
          expect: { sibling_file_touched: '*.test.ts' }
        }
      ]
    }];

    const scores = scoreRuleCompliance(events, rules);
    assert.equal(scores['TEST-001'].score, 0.5);
    assert.equal(scores['TEST-001'].evidence, 'behavioral-compliance');
  });

  it('scores 1.5 when both referenced AND behavioral match', () => {
    const events = [
      { tool: 'Write', referenced_context: ['TEST-001'], files_touched: ['src/auth.ts'] },
      { tool: 'Write', referenced_context: [], files_touched: ['src/auth.test.ts'] },
    ];
    const rules = [{
      id: 'TEST-001',
      text: 'Unit tests for all business logic',
      behavioral_signals: [
        {
          trigger: { file_glob: 'src/**/*.ts', tool: ['Write', 'Edit'] },
          expect: { sibling_file_touched: '*.test.ts' }
        }
      ]
    }];

    const scores = scoreRuleCompliance(events, rules);
    assert.equal(scores['TEST-001'].score, 1.5);
    assert.equal(scores['TEST-001'].evidence, 'verified-compliance');
  });

  it('scores 0.0 when sibling test file is missing', () => {
    const events = [
      { tool: 'Write', referenced_context: [], files_touched: ['src/auth.ts'] },
    ];
    const rules = [{
      id: 'TEST-001',
      text: 'Unit tests',
      behavioral_signals: [
        { trigger: { file_glob: 'src/**/*.ts', tool: ['Write'] }, expect: { sibling_file_touched: '*.test.ts' } }
      ]
    }];
    const scores = scoreRuleCompliance(events, rules);
    assert.equal(scores['TEST-001'].score, 0.0);
  });
});

describe('scoreRuleCompliance — preceded_by_read signal', () => {
  it('scores 0.5 when reference doc read before matching edit', () => {
    const events = [
      { tool: 'Read', referenced_context: [], files_touched: ['docs/security-patterns.md'], input_summary: 'docs/security-patterns.md' },
      { tool: 'Write', referenced_context: [], files_touched: ['src/auth/jwt.ts'] },
    ];
    const rules = [{
      id: 'SEC-001',
      text: 'Read security patterns before editing auth code',
      behavioral_signals: [
        {
          trigger: { file_glob: 'src/auth/**', tool: ['Write', 'Edit'] },
          expect: { preceded_by_read: 'docs/security-patterns.md' }
        }
      ]
    }];

    const scores = scoreRuleCompliance(events, rules);
    assert.equal(scores['SEC-001'].score, 0.5);
    assert.equal(scores['SEC-001'].evidence, 'behavioral-compliance');
  });

  it('does not match when read occurred AFTER the edit', () => {
    const events = [
      { tool: 'Write', referenced_context: [], files_touched: ['src/auth/jwt.ts'] },
      { tool: 'Read', referenced_context: [], files_touched: ['docs/security-patterns.md'], input_summary: 'docs/security-patterns.md' },
    ];
    const rules = [{
      id: 'SEC-001',
      text: 'Security patterns',
      behavioral_signals: [
        { trigger: { file_glob: 'src/auth/**', tool: ['Write'] }, expect: { preceded_by_read: 'docs/security-patterns.md' } }
      ]
    }];

    const scores = scoreRuleCompliance(events, rules);
    assert.equal(scores['SEC-001'].score, 0.0);
  });
});

describe('scoreRuleCompliance — content_includes signal (Phase 8)', () => {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

  it('scores 1.0 when response_snippet matches regex', () => {
    const events = [
      {
        tool: 'Edit',
        files_touched: ['src/auth.ts'],
        response_snippet: b64('import { timingSafeEqual } from "crypto";\n'),
        referenced_context: [],
      },
    ];
    const rules = [{
      id: 'SEC-002',
      text: 'Use timingSafeEqual for token comparison',
      behavioral_signals: [
        {
          trigger: { file_glob: 'src/**', tool: ['Edit', 'Write'] },
          expect: { content_includes: '\\btimingSafeEqual\\b' },
        },
      ],
    }];
    const scores = scoreRuleCompliance(events, rules);
    assert.equal(scores['SEC-002'].score, 1.0);
    assert.equal(scores['SEC-002'].evidence, 'content-verified');
  });

  it('scores 1.75 when both referenced AND content-verified', () => {
    const events = [
      {
        tool: 'Edit',
        files_touched: ['src/auth.ts'],
        response_snippet: b64('crypto.timingSafeEqual(a, b)\n'),
        referenced_context: ['SEC-002'],
      },
    ];
    const rules = [{
      id: 'SEC-002',
      text: '...',
      behavioral_signals: [
        { trigger: { tool: ['Edit'] }, expect: { content_includes: 'timingSafeEqual' } },
      ],
    }];
    const scores = scoreRuleCompliance(events, rules);
    assert.equal(scores['SEC-002'].score, 1.75);
    assert.equal(scores['SEC-002'].evidence, 'content-verified');
  });

  it('scores 0.0 when snippet does not match regex', () => {
    const events = [
      {
        tool: 'Edit',
        files_touched: ['src/auth.ts'],
        response_snippet: b64('const token = crypto.scrypt(pw, salt, 64);\n'),
        referenced_context: [],
      },
    ];
    const rules = [{
      id: 'SEC-002',
      text: '...',
      behavioral_signals: [
        { trigger: { tool: ['Edit'] }, expect: { content_includes: '\\bbcrypt\\b' } },
      ],
    }];
    const scores = scoreRuleCompliance(events, rules);
    assert.equal(scores['SEC-002'].score, 0.0);
  });

  it('fails safely when event has no snippet', () => {
    const events = [
      { tool: 'Edit', files_touched: ['src/auth.ts'], referenced_context: [] },
    ];
    const rules = [{
      id: 'SEC-002',
      text: '...',
      behavioral_signals: [
        { trigger: { tool: ['Edit'] }, expect: { content_includes: 'bcrypt' } },
      ],
    }];
    const scores = scoreRuleCompliance(events, rules);
    assert.equal(scores['SEC-002'].score, 0.0);
  });
});

describe('rule-registry — invalid content_includes regex', () => {
  it('rejects signal with unparseable regex at parse time', async () => {
    const { parseRulesYaml } = await import('./rule-registry.js');
    const yaml = `rules:
  BAD-001:
    text: invalid
    behavioral_signals:
      - trigger:
          tool: [Edit]
        expect:
          content_includes: "[unclosed"
`;
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const rules = parseRulesYaml(yaml);
      const rule = rules.get('BAD-001');
      assert.ok(rule);
      assert.equal((rule.behavioral_signals || []).length, 0);
    } finally {
      console.warn = origWarn;
    }
  });
});

describe('scoreRuleCompliance — applicability (not-applicable vs applicable-unmet)', () => {
  it('scores null / not-applicable when rule has signals but no trigger fired', () => {
    // Session touched no work-status file → the rule was never applicable.
    // Old behavior scored this 0.0/ignored, feeding false negatives to Elo.
    const events = [
      { tool: 'Read', referenced_context: [], files_touched: ['docs/x.md'] },
    ];
    const rules = [{
      id: 'WS-001',
      text: 'Update work-status',
      behavioral_signals: [
        { trigger: { tool: ['Write', 'Edit'], file_glob: '**/work-status.md' }, expect: { present: true } }
      ]
    }];
    const scores = scoreRuleCompliance(events, rules);
    assert.equal(scores['WS-001'].score, null);
    assert.equal(scores['WS-001'].evidence, 'not-applicable');
  });

  it('labels unmet content_includes as applicable-unmet, not ignored', () => {
    const events = [
      {
        tool: 'Write',
        files_touched: ['reports/sf/x.md'],
        response_snippet: Buffer.from('no statement here', 'utf8').toString('base64'),
        referenced_context: [],
      },
    ];
    const rules = [{
      id: 'DQ-001',
      text: 'Reports carry a Data Quality Statement',
      behavioral_signals: [
        { trigger: { tool: ['Write'], file_glob: 'reports/**' }, expect: { content_includes: 'Data Quality Statement' } }
      ]
    }];
    const scores = scoreRuleCompliance(events, rules);
    assert.equal(scores['DQ-001'].score, 0.0);
    assert.equal(scores['DQ-001'].evidence, 'applicable-unmet');
  });
});

describe('scoreRuleCompliance — expect.absent / expect.present', () => {
  it('scores 0.0 / violated when an absent-trigger fires (tool_glob)', () => {
    const events = [
      { tool: 'mcp__claude_ai_Google_Drive__search_files', referenced_context: [], files_touched: [] },
    ];
    const rules = [{
      id: 'GA-001',
      text: 'Google via integrations/, never MCP',
      behavioral_signals: [
        { trigger: { tool_glob: 'mcp__*{Google,google,Gmail,gmail}*' }, expect: { absent: true } }
      ]
    }];
    const scores = scoreRuleCompliance(events, rules);
    assert.equal(scores['GA-001'].score, 0.0);
    assert.equal(scores['GA-001'].evidence, 'violated');
  });

  it('scores 0.5 / behavioral-compliance when a present-trigger fires (input_regex)', () => {
    const events = [
      { tool: 'Bash', input_summary: 'gws gmail messages list --max 5', referenced_context: [], files_touched: [] },
    ];
    const rules = [{
      id: 'GA-001',
      text: 'Google via integrations/, never MCP',
      behavioral_signals: [
        { trigger: { tool: ['Bash'], input_regex: '\\bgws\\b' }, expect: { present: true } }
      ]
    }];
    const scores = scoreRuleCompliance(events, rules);
    assert.equal(scores['GA-001'].score, 0.5);
    assert.equal(scores['GA-001'].evidence, 'behavioral-compliance');
  });

  it('violated trumps referenced and a matching present signal', () => {
    const events = [
      { tool: 'Write', referenced_context: ['FO-009'], files_touched: ['stray.md'] },
      { tool: 'Write', referenced_context: [], files_touched: ['reports/ok.md'] },
    ];
    const rules = [{
      id: 'FO-009',
      text: 'Never create files in root',
      behavioral_signals: [
        { trigger: { tool: ['Write'], file_glob: '*.*' }, expect: { absent: true } },
        { trigger: { tool: ['Write', 'Edit'], file_glob: 'reports/**' }, expect: { present: true } },
      ]
    }];
    const scores = scoreRuleCompliance(events, rules);
    assert.equal(scores['FO-009'].score, 0.0);
    assert.equal(scores['FO-009'].evidence, 'violated');
  });

  it('absent signal with no trigger events → not-applicable', () => {
    const events = [
      { tool: 'Read', referenced_context: [], files_touched: ['docs/x.md'] },
    ];
    const rules = [{
      id: 'GA-001',
      text: 'Google via integrations/, never MCP',
      behavioral_signals: [
        { trigger: { tool_glob: 'mcp__*{Google,google,Gmail,gmail}*' }, expect: { absent: true } }
      ]
    }];
    const scores = scoreRuleCompliance(events, rules);
    assert.equal(scores['GA-001'].score, null);
    assert.equal(scores['GA-001'].evidence, 'not-applicable');
  });

  it('string-form rules keep legacy referenced/ignored semantics', () => {
    const events = [
      { tool: 'Read', referenced_context: ['WS-008'], files_touched: [] },
    ];
    const scores = scoreRuleCompliance(events, ['WS-008', 'CM-010']);
    assert.equal(scores['WS-008'].score, 1.0);
    assert.equal(scores['WS-008'].evidence, 'referenced');
    assert.equal(scores['CM-010'].score, 0.0);
    assert.equal(scores['CM-010'].evidence, 'ignored');
  });
});

describe('scoreRuleCompliance — file_not_modified signal', () => {
  it('scores 0.5 when forbidden files are not touched', () => {
    const events = [
      { tool: 'Write', files_touched: ['src/index.ts'] },
      { tool: 'Read', files_touched: ['src/generated/types.generated.ts'] },
    ];
    const rules = [{
      id: 'GEN-001',
      text: 'Do not edit generated files',
      behavioral_signals: [
        { trigger: { tool: ['Write', 'Edit'] }, expect: { file_not_modified: '**/*.generated.*' } }
      ]
    }];

    const scores = scoreRuleCompliance(events, rules);
    assert.equal(scores['GEN-001'].score, 0.5);
  });

  it('scores 0.0 when forbidden file IS edited', () => {
    const events = [
      { tool: 'Write', files_touched: ['src/index.ts'] },
      { tool: 'Edit', files_touched: ['src/generated/types.generated.ts'] },
    ];
    const rules = [{
      id: 'GEN-001',
      text: 'Do not edit generated files',
      behavioral_signals: [
        { trigger: { tool: ['Write', 'Edit'] }, expect: { file_not_modified: '**/*.generated.*' } }
      ]
    }];

    const scores = scoreRuleCompliance(events, rules);
    assert.equal(scores['GEN-001'].score, 0.0);
    // Breaching a file_not_modified guard is a violation, not mere absence of signal.
    assert.equal(scores['GEN-001'].evidence, 'violated');
  });
});

// D186 / OI-R78: for a rule with signals, behaviour decides. Part Y's session
// 01e39cd3 cited FO-005 25 times, wrote no PRD, and scored it 1.0 'referenced',
// which is how a citation passed the check meant to prove the rule was applied.
describe('scoreRuleCompliance — a citation alone never scores a rule with signals (D186)', () => {
  const FO005 = {
    id: 'FO-005',
    behavioral_signals: [
      { trigger: { tool: ['Write', 'Edit'], file_glob: '{reports,context}/**/*prd*.md' }, expect: { absent: true } },
      { trigger: { tool: ['Write'], file_glob: 'docs/prds/*.md' }, expect: { present: true } },
    ],
  };
  const REVIEW = {
    id: 'RV-001',
    behavioral_signals: [{ trigger: { tool: ['Write'], file_glob: 'docs/**/*.md' }, expect: { preceded_by_read: 'docs/style.md' } }],
  };

  it('a cited rule whose checks never fired is not-applicable, not referenced (the 01e39cd3 case)', () => {
    const events = [{ tool: 'Edit', referenced_context: ['FO-005'], files_touched: ['src/lib/x.js'] }];
    assert.deepEqual(scoreRuleCompliance(events, [FO005])['FO-005'], { score: null, evidence: 'not-applicable' });
  });

  it('a cited rule whose check fired with no compliant result is applicable-unmet 0.0', () => {
    const events = [{ tool: 'Write', referenced_context: ['RV-001'], files_touched: ['docs/guide.md'] }];
    assert.deepEqual(scoreRuleCompliance(events, [REVIEW])['RV-001'], { score: 0.0, evidence: 'applicable-unmet' });
  });

  it('cited and behavioural still scores verified-compliance 1.5', () => {
    const events = [{ tool: 'Write', referenced_context: ['FO-005'], files_touched: ['docs/prds/x-prd.md'] }];
    assert.deepEqual(scoreRuleCompliance(events, [FO005])['FO-005'], { score: 1.5, evidence: 'verified-compliance' });
  });

  it('a cited rule without signals still scores referenced 1.0', () => {
    const events = [{ tool: 'Read', referenced_context: ['CS-003'], files_touched: ['a.js'] }];
    assert.deepEqual(scoreRuleCompliance(events, [{ id: 'CS-003', text: 'functions under 40 lines' }])['CS-003'],
      { score: 1.0, evidence: 'referenced' });
  });

  it('prevented-mistake does not score 2.0 when none of the rule checks fired', () => {
    const events = [
      { tool: 'Read', input_summary: 'context/anti-patterns/file-organization.md', referenced_context: ['FO-005'], files_touched: [] },
      { tool: 'Edit', referenced_context: [], files_touched: ['src/lib/x.js'] },
    ];
    assert.deepEqual(scoreRuleCompliance(events, [FO005])['FO-005'], { score: null, evidence: 'not-applicable' });
  });

  it('prevented-mistake still scores 2.0 when a check fired and nothing was violated', () => {
    const events = [
      { tool: 'Read', input_summary: 'context/anti-patterns/file-organization.md', referenced_context: ['FO-005'], files_touched: [] },
      { tool: 'Write', referenced_context: [], files_touched: ['docs/prds/x-prd.md'] },
    ];
    assert.deepEqual(scoreRuleCompliance(events, [FO005])['FO-005'], { score: 2.0, evidence: 'prevented-mistake' });
  });
});

// D193 / OI-R81: CS-003's only signal is applicable_only, which says when the
// rule applies but declares no behaviour. Under D186 alone such a rule could
// only score 0.0 or n/a, so its rating could only fall, a demotion made by the
// measurement. It is scored like a rule without signals: a citation counts.
describe('scoreRuleCompliance — applicable_only-only rules score like signal-less rules (D193)', () => {
  const CODE = { trigger: { tool: ['Write', 'Edit'], file_glob: '**/*.{js,ts,py,sh}' }, expect: { applicable_only: true } };

  it('a cited applicable_only rule scores 1.0 referenced when code was written', () => {
    const events = [{ tool: 'Write', referenced_context: ['CS-003'], files_touched: ['scripts/foo.js'] }];
    const scores = scoreRuleCompliance(events, [{ id: 'CS-003', behavioral_signals: [CODE] }]);
    assert.deepEqual(scores['CS-003'], { score: 1.0, evidence: 'referenced' });
  });

  it('a cited applicable_only rule scores 1.0 referenced with no code written, like any signal-less rule', () => {
    const events = [{ tool: 'Read', referenced_context: ['CS-003'], files_touched: ['docs/x.md'] }];
    const scores = scoreRuleCompliance(events, [{ id: 'CS-003', behavioral_signals: [CODE] }]);
    assert.deepEqual(scores['CS-003'], { score: 1.0, evidence: 'referenced' });
  });

  it('an uncited applicable_only rule scores 0.0 ignored, as a signal-less rule does', () => {
    const events = [{ tool: 'Write', referenced_context: [], files_touched: ['scripts/foo.js'] }];
    const scores = scoreRuleCompliance(events, [{ id: 'CS-003', behavioral_signals: [CODE] }]);
    assert.deepEqual(scores['CS-003'], { score: 0.0, evidence: 'ignored' });
  });

  it('a rule with applicable_only AND a real check is still scored by behaviour (D186)', () => {
    const events = [{ tool: 'Write', referenced_context: ['X-001'], files_touched: ['scripts/foo.js'] }];
    const rules = [{ id: 'X-001', behavioral_signals: [
      CODE,
      { trigger: { tool: ['Write'], file_glob: 'reports/**' }, expect: { content_includes: 'Data Quality Statement' } },
    ] }];
    const scores = scoreRuleCompliance(events, rules);
    assert.deepEqual(scores['X-001'], { score: 0.0, evidence: 'applicable-unmet' });
  });
});
