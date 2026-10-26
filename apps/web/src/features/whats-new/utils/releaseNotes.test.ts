import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizeHtml } from '@/lib/markdown';
import { releaseHighlights, tagSections } from './releaseNotes';

// The body of the v1.9.0 release as GitHub carries it: release-please markdown.
const V190_BODY = `## [1.9.0](https://github.com/gtko/Telic/compare/v1.8.0...v1.9.0) (2026-10-25)


### Features

* add GitHub issue and discussion tools for AI agents ([#669](https://github.com/gtko/Telic/issues/669)) ([5137eed](https://github.com/gtko/Telic/commit/5137eedcfd46737f3d3880793acf3d32f9733ba5))
* **api:** create checklist items in bulk ([#683](https://github.com/gtko/Telic/issues/683)) ([fd5caf9](https://github.com/gtko/Telic/commit/fd5caf9e913764f931233f01f9d0c520876dd199))
* **api:** D1 invariants for invites, account deletion, SCIM (resumable reconcile), settings, god; vitest suites (ody-296 l3c2) ([04234d6](https://github.com/gtko/Telic/commit/04234d6a1f7241f49e2c330537b8b2fda74cb2d5))
* **api:** documents, note-boards, attachments on D1 with concurrency tests (ody-296 l3b) ([0d57b1f](https://github.com/gtko/Telic/commit/0d57b1fe7d5cbf07498c698b1c6560f4ba5f1e04))
* **api:** ody-296 extract PDF text with unpdf (pure JS) instead of the native pdf-inspector ([a1e7d3a](https://github.com/gtko/Telic/commit/a1e7d3a7467b79269e62af6d6ab866f0c1c38ebf))
* **api:** port columns, views, custom-fields, issue-templates, initiatives to D1 batch (ody-296 l3a, partial) ([84d6733](https://github.com/gtko/Telic/commit/84d673338b463c8891aeb435128c2e7af21e1cac))
* **api:** port git service to D1 json functions (ody-296 l2e) ([d4f2d52](https://github.com/gtko/Telic/commit/d4f2d52305c9c2475cbbc57df85ccca88bb4efcf))
* **api:** port issues module to D1 batches (ody-296 l3a) ([c236770](https://github.com/gtko/Telic/commit/c236770033ded95a5ccebe3f00867e38008a579c))
* **api:** port projects module to D1 batches (ody-296 l3a) ([84042db](https://github.com/gtko/Telic/commit/84042dbb92995265b01c9b9056fec13ef4c797f5))
* **api:** wire agent runtime, cron and queue to the Worker handlers, inject db in agents module (ody-296) ([5d7cd6a](https://github.com/gtko/Telic/commit/5d7cd6a4fd3ce532dba30809af4f3340af927c82))
* **api:** Worker entry, request context (db/env/auth), wrangler config, vitest workers helper (ody-296 l6api) ([5ff2761](https://github.com/gtko/Telic/commit/5ff2761dce44691070a35eaad52b5e66b0a10504))
* **auth:** per-request better-auth factory over D1 (ODY-296 L2w) ([d5ab2c5](https://github.com/gtko/Telic/commit/d5ab2c51f0ceab831a5bac70ac570d6d7f6a0519))
* **bot:** Telegram updates over a Worker webhook (ODY-296 L6bot) ([7c1febf](https://github.com/gtko/Telic/commit/7c1febf54b06f03cdb52b7bdc25f19f92cf7a67d))
* **cron:** shared @repo/cron grammar (cron-parser) for api and worker, telemetry vtest, Resend-only email probe (ody-296 integ-d) ([dfa2c37](https://github.com/gtko/Telic/commit/dfa2c37ee0a36014554b86588391cea3ea8a9c7e))
* **db:** D1-only schema, generated auth tables, single baseline (ODY-296 L1) ([0f6f996](https://github.com/gtko/Telic/commit/0f6f996374980aa86bbe8cdfb6eacfb75fa5dbbd))
* **db:** script de copie Postgres -> D1 (ody-296 L8) ([1e223af](https://github.com/gtko/Telic/commit/1e223af4599aa25ff24601a2645e98cec79c00f8))
* **desktop:** add Tauri 2 Windows shell for the web app (ody-296) ([b3f5185](https://github.com/gtko/Telic/commit/b3f518591a8ea9388bf181bb94e4ea852dc60bdb))
* **net,mailer,storage:** compat Workers, DoH SSRF guard, Resend only, R2 binding (ody-296 l6net) ([a9949a8](https://github.com/gtko/Telic/commit/a9949a8ba7030b9c9063ea66973bbfec63359504))
* **shared,db,auth:** db-first access/limits/mcp/current-user, Db exposes $client, DB_SIGNATURES (ody-296 integ-c) ([96a8c06](https://github.com/gtko/Telic/commit/96a8c06ee643ca02ec97d83164866d28ab3bb2fc))
* **web:** port Next 16 to Cloudflare Workers via OpenNext, sanitize without jsdom (ody-296 l6web) ([bda2f18](https://github.com/gtko/Telic/commit/bda2f18c26240e36f1d49c45fdbda73697b4ceba))


### Improvements

* **web:** edit an initiative's status from the initiatives list (ody-320) ([#5](https://github.com/gtko/Telic/issues/5)) ([1d78f79](https://github.com/gtko/Telic/commit/1d78f798031c9b7709b7715fd4d50ef25a49d323))


### Bug Fixes

* **api:** analytics queries ported to SQLite (epoch ms buckets, no date_trunc/generate_series), with D1 tests (ody-296) ([dffaf31](https://github.com/gtko/Telic/commit/dffaf316bc2a663072d53dfbac498df5f9c52309))
* **api:** attachment quota insert detects success via RETURNING, D1 meta.changes counts trigger writes (ody-296) ([755f8f8](https://github.com/gtko/Telic/commit/755f8f842c70d3928e6a4918c1c8cf12c2d24727))
* **api:** bind R2 in request context, drop stray db keys, sqlite targetWhere, cron-parser interop in tests (ody-296) ([21ee5f3](https://github.com/gtko/Telic/commit/21ee5f33fdeca3c2a47500e8668addf7200d310e))
* **api:** cycles and user preferences use SQLite date/time SQL, with D1 tests (ody-296) ([789f187](https://github.com/gtko/Telic/commit/789f1870ab4d430e9f2d38501c79bb856a337f6a))
* **api:** document links and tree fence read success from RETURNING, triggers own the documents marker (ody-296) ([12c3bf6](https://github.com/gtko/Telic/commit/12c3bf66298780cc7186b9d21b1332801f2c0d7e))
* **api:** drop chat_attachment from storage quota SQL after 0006 (ody-296) ([0086e41](https://github.com/gtko/Telic/commit/0086e41a08bc70433ff0f42b4481aca0e0f27421))
* **api:** expose the R2 bucket on the request context, NODE_ENV=test in workers tests ([8605844](https://github.com/gtko/Telic/commit/8605844f2a82ece86c9f7e74fd62fcc7df30c2b3))
* **api:** initiatives list handler takes db (ody-296 l3a) ([f5e01f7](https://github.com/gtko/Telic/commit/f5e01f7717057d2af1e0b80fe230102adef2be73))
* **api:** keep repository webhook text bodies and request tracker answers under the dynamic handler (ody-296) ([4caece4](https://github.com/gtko/Telic/commit/4caece4e63d38d9228b2cdaaf4240120157f7781))
* **api:** map D1 constraint failures to 409, keep oauth_resource between tests ([cb7f302](https://github.com/gtko/Telic/commit/cb7f30279434c9eb29bda37723df81b7d4b90c24))
* **api:** ody-296 build the swagger docs page per request so the Worker module loads ([bfb86dc](https://github.com/gtko/Telic/commit/bfb86dceb44e0ed1815c4aba88360c67587cce68))
* **api:** ody-296 claim chat answers on D1 and route storage to R2 in cron and queue handlers ([08a41d1](https://github.com/gtko/Telic/commit/08a41d16aa6c65552e8c0af6e00e7f0606ee15a0))
* **api:** ody-296 make the dynamic Elysia handler match the composed one for request bodies ([b3843c0](https://github.com/gtko/Telic/commit/b3843c0ec1220f620c19547b4feb565f58218803))
* **api:** tsc cleanup, runtime for deleteProject/trace, queue threading, @repo/cron (ody-296) ([27404b8](https://github.com/gtko/Telic/commit/27404b8f2969de3634feb52eefac83ccb1328c7e))
* **auth:** require BETTER_AUTH_SECRET, derive Secure cookies from the URL, rate limit in D1 ([72beb33](https://github.com/gtko/Telic/commit/72beb33e00236d7f52ac34d0dd8d95a9c9ca6259))
* **ci:** align pg-to-d1 table count, patch audited deps, clear CodeQL alerts (ody-296) ([093e286](https://github.com/gtko/Telic/commit/093e2860d1549682077bb826945a15eefc08820d))
* **db,api:** batchable abortBatchWhen, drop-workspace handover plan with post-checks, D1 invariant tests (ody-296 l3c1) ([cb03ae2](https://github.com/gtko/Telic/commit/cb03ae22f2567f7e8ee2c7669950590bfe3ac7c4))
* **db:** review fixes, D1 triggers and seed, atomic storage quota (ody-296 ltrig) ([24ae32c](https://github.com/gtko/Telic/commit/24ae32cc7a3743bdfe517bfb693fcbc27f232272))
* **invites:** surface received invitations on start and account pages ([#667](https://github.com/gtko/Telic/issues/667)) ([bf6814f](https://github.com/gtko/Telic/commit/bf6814fb066d40091797d31f86c85a761eefcd5b))
* **mcp:** answer server/discover, key the rate limit by client IP, skip redundant work per request (ody-296) ([314fc57](https://github.com/gtko/Telic/commit/314fc5787230f344cf785762dfbee04bf0b32cb5))
* **mcp:** answer server/discover, share rate-limit per client IP (ody-296) ([cf22a0d](https://github.com/gtko/Telic/commit/cf22a0dcef62c3c55edf6b7b76fca365bfec54bf))
* **net:** make SSRF dev mode opt-in and harden private IPv6 ranges ([ec778e3](https://github.com/gtko/Telic/commit/ec778e3a13f2b658e298bd59a0135ac740c9dd3b))
* pass pre-migration backup override through Helm ([#682](https://github.com/gtko/Telic/issues/682)) ([523995a](https://github.com/gtko/Telic/commit/523995a4d987e8e1d66b0f2ed8258ba7b0f04133))
* **web:** handle null activity action (ody-296) ([f94977e](https://github.com/gtko/Telic/commit/f94977e015779bcd8360243cb99fc15cbd2f022d))


### Refactoring

* **api:** db-first analytics/share, bucket injection for attachments, god env redirects (ody-296) ([2f9ae85](https://github.com/gtko/Telic/commit/2f9ae85935e9cf98b732e69bbda3a9ed52c84cc8))
* **api:** db-first cycles, issue-types, labels, sync, user-preferences; entityGuard lookups read ctx.db (ody-296) ([3831942](https://github.com/gtko/Telic/commit/383194205a33132d559e78161cd359346478ca5d))
* **api:** drop AI dependencies (ody-296) ([3d7f53c](https://github.com/gtko/Telic/commit/3d7f53c3a772bcb71717ac35add84e302e659cf3))
* **api:** last-owner and membership invariants as batch guards, no db.transaction in teams/members/roles/workspaces (ody-296 l3c1) ([ca83fbf](https://github.com/gtko/Telic/commit/ca83fbf11b1261262e13b394668686a2715dde56))
* **api:** port actions, chat-attachments, import-export, imports, webhooks, notifications to explicit db (ody-296 l2e) ([8efa0cc](https://github.com/gtko/Telic/commit/8efa0ccc56889b7c75b703867f5c9ccd3928b59b))
* **api:** port avatars, telegram, connected-apps, notification settings and dashboards to explicit db (ODY-296 L2e, WIP) ([49c9bf1](https://github.com/gtko/Telic/commit/49c9bf13ff5ab1e5716c821eee8d25930b6e48bb))
* **api:** port git module remainder to explicit db (ody-296 l2e) ([21d72cf](https://github.com/gtko/Telic/commit/21d72cf29adb4a8b2733f1f1126181181ab74056))
* **api:** remove agent tests and helpers (ody-296) ([1c6ae3c](https://github.com/gtko/Telic/commit/1c6ae3c00d9679e4f03c09ed1983f03fe01b0586))
* **api:** remove agent traces from api sources (ody-296) ([168849a](https://github.com/gtko/Telic/commit/168849abf6acdc5529662b68b9d8616e8aff3b7e))
* **api:** remove AI features (ody-296) ([dbe469a](https://github.com/gtko/Telic/commit/dbe469a8748f4499d0080539fb4332facd599f0d))
* **api:** thread explicit db through issues and projects modules (ody-296 l3a, mechanical) ([ee2adda](https://github.com/gtko/Telic/commit/ee2adda4606744d8dfad6661ea165fd1a3257c55))
* **api:** thread explicit db through teams, members, invites, roles, workspaces, god, scim, settings (ody-296 l3c, mechanical WIP) ([129f1bc](https://github.com/gtko/Telic/commit/129f1bc10887d78b2d88bdcba51e6399ec6b0503))
* **bot:** db passed in, links redeemed in one UPDATE (ODY-296 L6bot) ([1fe90fd](https://github.com/gtko/Telic/commit/1fe90fda93c657d14a37ddd6769d30b3c05c18af))
* **brand:** rename to Telic in api (ody-296) ([8ca2235](https://github.com/gtko/Telic/commit/8ca223587ab1d8b72a144959effd28e9188eecd8))
* **brand:** rename to Telic in web (ody-296) ([be18a69](https://github.com/gtko/Telic/commit/be18a699fe85a657add25e9423b45e6dd8371a56))
* **brand:** rename to Telic in worker and packages (ody-296) ([e00ca16](https://github.com/gtko/Telic/commit/e00ca16210985a10ec1c0149f54e3ed7b0c7c812))
* **db:** remove AI tables (ody-296) ([62117e7](https://github.com/gtko/Telic/commit/62117e72b7b4d672668a2e83f08414be27ad3f1b))
* remove agent packages, worker schedules and auth agent checks (ody-296) ([43b01c8](https://github.com/gtko/Telic/commit/43b01c8e0293d303d9cd5b41f7480da57e7dbefd))
* **web:** drop orphan cron utils, chat-attachments media root, delegate prompt tag (ody-296) ([3eafae7](https://github.com/gtko/Telic/commit/3eafae70944ba08564d0de974cf26fc572df2946))
* **web:** remove AI navigation, team AI sections, integrations and i18n keys (ody-296) ([f256874](https://github.com/gtko/Telic/commit/f2568745d31e651c5a6d5bd2ddee81c907ac4ab4))
* **web:** remove copy prompt, member kind filter, archived agent activity (ody-296) ([6d3690a](https://github.com/gtko/Telic/commit/6d3690aa3a93e78b10b16a3ea66accb8e217b7bf))
* **web:** remove delegate, agent members and AI leftovers (ody-296) ([758d35c](https://github.com/gtko/Telic/commit/758d35c67235661339aadde94185ad762bed4558))


### Documentation

* add Pro purchase and contributors to README ([#684](https://github.com/gtko/Telic/issues/684)) ([3c7712f](https://github.com/gtko/Telic/commit/3c7712fc8f941f22c22db8cc45e36719138fd6f6))
* **brand:** rename to Telic in docs and root files (ody-296) ([a28fb2c](https://github.com/gtko/Telic/commit/a28fb2c1ae2e9c1523586d05006437010a4165e7))
* describe Telic without AI agents (ody-296) ([147849b](https://github.com/gtko/Telic/commit/147849bda7cb29f5678f4001874b57ae455bdcff))
* ody-296 describe the Cloudflare-only architecture ([2feb695](https://github.com/gtko/Telic/commit/2feb695da45e740f03514a9a29972b2a9c25e46e))


### Build

* **api:** ody-296 point the four Workers at the telic D1 database and telic-attachments bucket ([b7b7bac](https://github.com/gtko/Telic/commit/b7b7bacf7a78d8937ddf4028154dd8bc791df34d))
* pin APP_URL/API_URL in wrangler configs, drop upstream CLA workflow, set deploy env (ody-296) ([c2ac2e9](https://github.com/gtko/Telic/commit/c2ac2e9e75a39533b1d580d5d5d6f2a8cede0501))
* pin worker URLs, drop CLA workflow, add Windows desktop shell (ody-296) ([5c4ac4f](https://github.com/gtko/Telic/commit/5c4ac4f0d24714f947a89308c657470a5cf0e672))


### Tests

* **api:** D1 service-level suites for issues, columns and projects (ody-296 l3a) ([222cdeb](https://github.com/gtko/Telic/commit/222cdeb27cae85e1a4911fe271423915f93a54a6))
* **api:** D1 vtest for agent traces, analytics and retention; drop pg cast in schedules (ody-296) ([c719069](https://github.com/gtko/Telic/commit/c7190694b7d42a5521c07618b94c1f25e9371ee6))
* **api:** D1 vtest for the agent_run queue (claim/lease/concurrency), fix RETURNING alias in claimRun, span payloads in BUCKET (ody-296) ([196b100](https://github.com/gtko/Telic/commit/196b1007b36e4ceb8582bdfe590fd4cbecd48554))
* **api:** drop enqueueAgentRun mock from vitest setup (ody-296) ([76a2bfd](https://github.com/gtko/Telic/commit/76a2bfd0ea013a4209b23886fe4e57287abf13ed))
* **api:** drop stale cross-module mocks, align projects vtest with db-first signatures, stub cloudflare:workers for node project (ody-296) ([3389752](https://github.com/gtko/Telic/commit/3389752658fa9c9569099704a39b0123c4daaf53))
* **api:** exclude still-red ported tests, document them in PORTING_TESTS_TODO ([234212d](https://github.com/gtko/Telic/commit/234212d45c09d5a766f5a24037e29d24fd188faa))
* **api:** fix types of the D1 test helper (ody-296 l3a) ([bffbabe](https://github.com/gtko/Telic/commit/bffbabea9e3ed7993218892b1108b3b801705f05))
* **api:** per-client IPs for test sign-ups, SSRF dev flag in tests, run claim concurrency ([08105f6](https://github.com/gtko/Telic/commit/08105f6c32b51f626aee8776380ad7b7aae7b3cd))
* **api:** port remaining route tests, helpers and excluded list (ody-296) ([4ecece6](https://github.com/gtko/Telic/commit/4ecece6b626ea43142650b473e69bdf29c8de408))
* **worker:** concurrency tests of the four claims, quoted trigger column, bot/net typing (ody-296 integ-d) ([643906d](https://github.com/gtko/Telic/commit/643906d84af7eafe7bb1e64956d768156db09fd7))
* **worker:** port the 6 integration suites to Miniflare D1 vtests, Resend-only notification-send (ody-296 integ-d) ([e984d10](https://github.com/gtko/Telic/commit/e984d108e139a34be9b9c79306f922412a7a2674))


### Chores

* **db:** snapshot of the merged schema (0004), journal 0003_agent_spans/0004_project_tree (ody-296) ([3214b8f](https://github.com/gtko/Telic/commit/3214b8f46586508ab407afe83cc1bae3f5b88901))
* ody-296 remove Docker, Helm and self-host files, add Cloudflare CI and deploy workflows ([69017ff](https://github.com/gtko/Telic/commit/69017ffc4082324e8593e150d612424b6080fd09))
* regenerate bun.lock after merge of the ody-296 lots (vitest 4.1.12 pinned in apps/api for the workers pool) ([9c07670](https://github.com/gtko/Telic/commit/9c0767077d7daa57ef57dee95ae0c1d7e2fa63b4))
* **worker:** remove telemetry sending to upstream collector (ody-296) ([b74a245](https://github.com/gtko/Telic/commit/b74a24520f5ff12136b77216f4df8d6ae87cf5a3))`;

describe('tagSections', () => {
  it('adds the kind of each known section title', () => {
    assert.equal(tagSections('<h3>Features</h3>'), '<h3 data-kind="feat">Features</h3>');
    assert.equal(tagSections('<h3>Bug Fixes</h3>'), '<h3 data-kind="fix">Bug Fixes</h3>');
    assert.equal(tagSections('<h3>Chores</h3>'), '<h3 data-kind="other">Chores</h3>');
  });

  it('leaves an unknown title unchanged', () => {
    const html = '<h3>Misc</h3><ul><li>a</li></ul>';
    assert.equal(tagSections(html), html);
  });

  // ReleaseBody sanitizes first, then tags: tagSections keeps what it is given.
  it('keeps an attribute it is given and adds only data-kind', () => {
    assert.equal(
      tagSections('<h3 onclick="x">Features</h3>'),
      '<h3 onclick="x" data-kind="feat">Features</h3>',
    );
    assert.equal(
      tagSections(sanitizeHtml('<h3 onclick="x">Features</h3>')),
      '<h3 data-kind="feat">Features</h3>',
    );
  });
});

describe('releaseHighlights', () => {
  it('counts the items of each section in the v1.9.0 changelog', () => {
    assert.deepEqual(releaseHighlights({ notes: V190_BODY, notesFormat: 'markdown' }), [
      { kind: 'feat', count: 20 },
      { kind: 'improvement', count: 1 },
      { kind: 'fix', count: 24 },
      { kind: 'docs', count: 4 },
      { kind: 'other', count: 40 },
    ]);
  });

  it('counts the li of HTML notes and skips a section it does not know', () => {
    const notes =
      '<h3>Features</h3><ul><li>a</li><li>b</li></ul>' +
      '<h3>Misc</h3><ul><li>c</li></ul>' +
      '<h3>Bug Fixes</h3><ul><li>d</li></ul>';
    assert.deepEqual(releaseHighlights({ notes, notesFormat: 'html' }), [
      { kind: 'feat', count: 2 },
      { kind: 'fix', count: 1 },
    ]);
  });

  it('counts * and - bullets alike', () => {
    const notes = '### Features\n\n* a\n- b\n';
    assert.deepEqual(releaseHighlights({ notes, notesFormat: 'markdown' }), [
      { kind: 'feat', count: 2 },
    ]);
  });

  it('orders kinds from feat to other, whatever the order of the sections', () => {
    const notes = '### Chores\n\n* x\n\n### Features\n\n* y\n';
    assert.deepEqual(releaseHighlights({ notes, notesFormat: 'markdown' }), [
      { kind: 'feat', count: 1 },
      { kind: 'other', count: 1 },
    ]);
  });
});
