// test/skills.mjs — skill discovery.
//
// ACP exposes no skill surface, so the catalog is rebuilt from disk using the layout
// dsh-skill-filesystem documents. The decisive test is the last one: the scan must
// produce the same list dsh itself hands the agent.
import { discoverSkills, parseFrontmatter, loadSkills, defaultSkillRoots } from '../out/skills.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

let failures = 0;
const check = (n, fn) => { try { fn(); console.log('  ✓ ' + n); } catch (e) { failures++; console.log('  ✗ ' + n + '\n      ' + e.message); } };

const root = mkdtempSync(join(tmpdir(), 'dsh-skills-'));
const mk = (dir, name, body) => {
  mkdirSync(join(root, dir, name), { recursive: true });
  writeFileSync(join(root, dir, name, 'SKILL.md'), body);
};
const flat = (dir, file, body) => {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, file), body);
};
const fm = (o) => '---\n' + Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n---\n\n# body\n';

console.log('\n1. frontmatter');
check('plain scalars', () => {
  const f = parseFrontmatter(fm({ name: 'a', description: 'does a thing' }));
  assert.equal(f.name, 'a'); assert.equal(f.description, 'does a thing');
});
check('single-quoted values are unwrapped', () => {
  const f = parseFrontmatter("---\nname: a\ndescription: 'has: a colon'\n---\n");
  assert.equal(f.description, 'has: a colon');
});
check('block scalars fold', () => {
  const f = parseFrontmatter('---\nname: a\ndescription: >\n  line one\n  line two\n---\n');
  assert.equal(f.description, 'line one line two');
});
check('no frontmatter yields null', () => assert.equal(parseFrontmatter('# just a heading'), null));

console.log('\n2. discovery');
mk('proj/.dsh/skills', 'alpha', fm({ name: 'alpha', description: 'project alpha' }));
flat('user/skills', 'beta.md', fm({ name: 'beta', description: 'flat file skill' }));
mkdirSync(join(root, 'user/skills/nested/deep'), { recursive: true });
writeFileSync(join(root, 'user/skills/nested/deep/SKILL.md'), fm({ name: 'deep', description: 'too deep' }));
mk('user/skills', '.system', fm({ name: 'system', description: 'hidden' }));
const roots = [
  { rank: 100, source: 'project-dsh', dir: join(root, 'proj/.dsh/skills') },
  { rank: 400, source: 'user-dsh', dir: join(root, 'user/skills') },
];
const found = discoverSkills(roots);
check('directory bundles and flat files both found', () =>
  assert.deepEqual(found.map((s) => s.name).sort(), ['alpha', 'beta']));
check('nested SKILL.md is deliberately not discovered', () =>
  assert.ok(!found.some((s) => s.name === 'deep')));
check('dot-prefixed entries such as .system are skipped', () =>
  assert.ok(!found.some((s) => s.name === 'system')));
check('the source root is recorded', () =>
  assert.equal(found.find((s) => s.name === 'alpha').source, 'project-dsh'));
check('a missing root is not an error', () =>
  assert.equal(discoverSkills([{ rank: 1, source: 'x', dir: join(root, 'nope') }]).length, 0));

console.log('\n3. precedence and flags');
mk('proj/.dsh/skills', 'shared', fm({ name: 'shared', description: 'from project' }));
mk('user/skills', 'shared', fm({ name: 'shared', description: 'from user' }));
check('lower rank wins a name clash', () =>
  assert.equal(discoverSkills(roots).find((s) => s.name === 'shared').description, 'from project'));
mk('user/skills', 'hidden', fm({ name: 'hidden', description: 'x', 'disable-model-invocation': 'true' }));
mk('user/skills', 'noui', fm({ name: 'noui', description: 'x', 'user-invocable': 'no' }));
const flags = discoverSkills(roots);
check('disable-model-invocation is read', () =>
  assert.equal(flags.find((s) => s.name === 'hidden').modelInvocable, false));
check('user-invocable accepts yes/no spelling', () =>
  assert.equal(flags.find((s) => s.name === 'noui').userInvocable, false));
mk('user/skills', 'broken', '---\nname: broken\n---\n');
check('a skill without a description is dropped', () =>
  assert.ok(!discoverSkills(roots).some((s) => s.name === 'broken')));

console.log('\n4. default roots');
check('mirrors the documented table', () => {
  const r = defaultSkillRoots('/p', '/dsh', '/agents').map((x) => `${x.rank}:${x.dir}`);
  assert.deepEqual(r, [
    '100:/p/.dsh/skills', '200:/p/.agents/skills', '400:/dsh/skills', '500:/agents/skills',
  ]);
});

console.log('\n5. against this machine');
const real = loadSkills(process.cwd());
console.log(`  found ${real.length}: ${real.map((s) => s.name).join(', ') || '(none)'}`);
check('real skills carry both required fields', () =>
  assert.ok(real.every((s) => s.name && s.description)));

console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
