# Team policy and overrides

aimhooman's per-clone defaults serve a solo developer. This page covers the
team layer: a versioned policy file, local overrides, and local rule packs,
plus how this repository's own CI authorizes changes to protected paths.

## Versioned team policy

Commit `.aimhooman.json` when every clone should use the same baseline:

```json
{
  "schema_version": 1,
  "profile": "strict"
}
```

The project policy takes precedence over the per-clone profile written by `init`.
An individual `check` may escalate to `--profile strict`, but cannot weaken or replace
the team profile. Malformed project policy fails closed with an actionable error;
personal allow/deny exceptions and local rule packs remain in the common Git directory
under `aimhooman/`.
A committed policy this version cannot read counts as strict until a readable one
replaces it: the repair commit goes through, and a replacement weaker than strict
needs the same bound `policy-review` a strict downgrade does.
A commit is judged by the policy in its own tree, so a commit that adds the file could
lower the profile it is judged by. A clone that chose `strict` itself (`init --profile
strict`) keeps it against a policy file that is new in a commit made there: the commit
is blocked until the user sets the clone's profile with `init --profile`, which only
the user does. A commit a fetch brought in was not made there, whoever committed it, so
a pull of the user's own commits from another machine still lands, and so does a merge, a diverged pull
included, since the commits it merges are history. A plain `init` keeps the strict profile this clone chose
when the policy file names a weaker one. Clean and compliance are not ordered, so a clone on one of them takes
the policy file's profile (there the file's action is `review`); an agent is refused when
it stages or commits `.aimhooman.json`, because a policy change is the user's to make.
The refusal reads `git add` and `git commit` for what they would take of the file in the
state it is in: `add -A`, `add .` and a pathspec that reaches it take a new file, `add -u`
and `commit -a` only a tracked change, `add -f` an ignored one; a dry run, an exclusion
such as `':!.aimhooman.json'` and a path that cannot reach the file take nothing. A line
that writes the file with a redirect, `tee`, `cp`, `mv`, `sed -i` or `rm` and then stages it
is refused too, and so is a commit while a change to the file is staged, a rename away from
it included. A staged change the user reviewed with `policy-review` may be committed, and a
commit whose message comes from a substitution is refused while the file has a change,
since the substitution is not read to its end. Code that writes the file (`python -c`,
`node -e`) is not read, and another command that stages it in the same line as a commit
(`apply --index`, `checkout <rev> -- .aimhooman.json`) is refused at the next commit, not
within that line; the floor above for a clone that chose `strict` judges the commit, not
the command that staged the file.
Under `strict`, policy files and agent instructions are blocking findings (exit 10):
both rules' strict action is `block`, not review. The product's `review` and
`policy-review` commands record local, object-bound decisions. An ordinary path or
rule allow does satisfy those engine findings; the one finding an allow cannot
satisfy is the strict-policy downgrade-or-removal block, which is constructed
outside the engine and clears only through a bound `policy-review` acknowledgment.

### Owner authorization in CI

This is how aimhooman's own repository accepts changes to protected paths (agent
instruction files and `.aimhooman.json`) in CI. The scripts that do it pin this
repository and its owner; the npm package does not carry them and the GitHub Action
never runs them. In any other repository nothing approves these changes in CI: a `strict` range
check fails on them, and `clean` reports them as notices
([docs/integrations.md](integrations.md#github-actions)).

For a protected-path change, this repository's CI verifies the pinned repository and
owner login plus numeric IDs through the GitHub API, then inspects the exact
workflow-run attempt. GitHub must attribute both `actor` and `triggering_actor`,
including their numeric IDs, to that owner. CI then binds the authorization to the
exact head, transition commit, path, resulting blob and regular-file mode, or
deletion tombstone. A strict-policy
migration also binds its old and new policy objects. A different attempt, commit, path
result, mode, or policy transition needs fresh authorization. A change not attributed to
the owner fails closed. This is owner authorization verified through GitHub attribution,
not independent review.

## Overrides

Every decision has a rule ID, so you can resolve a finding narrowly:

```sh
aimhooman allow AGENTS.md --reason "shared team config"   # stop flagging this path
aimhooman deny  path/or/rule-id                            # always block it
aimhooman explain claude.session-state                     # why a rule fires
```

Overrides live in the repository's common Git directory under
`aimhooman/overrides.json` (local, never committed), so linked worktrees share them.
An allow entry's scope is `path` or `rule`.

```sh
aimhooman override list --json
aimhooman override remove AGENTS.md
aimhooman override reset --all
```

Secret scanning left the product in v0.3.0, and the `secret-path` allow scope went
with it: existing `secret-path` entries are dropped on load with a warning, and the
rest of the file keeps working. Use a dedicated scanner for credentials instead —
[docs/secrets.md](secrets.md) explains the reasoning and shows the gitleaks setup.

## Local rule packs

Add your own per-repository detection with local rule packs in the common Git directory
under `aimhooman/rules/*.json`
(the structural schema is in [`schemas/rule-pack.schema.json`](../schemas/rule-pack.schema.json);
local rules only add detection — they can't weaken
a built-in block). Within one rule, local content patterns are capped at 32 expressions,
512 characters per expression, and 4,096 characters total. Path and exception scopes
share the same glob count, per-expression, and total limits. They use a flat subset: literals,
character classes, anchors, dot, escapes, and fixed `{n}` repeats. Groups, alternation,
lookaround, backreferences, and variable quantifiers are rejected. A local expression
does not run on a line longer than 16,384 characters; that skip is reported and makes the
scan incomplete. Path rules are case-sensitive by default. Set
`match.path_case` to `"insensitive"` only for a security name whose meaning is
case-insensitive, such as `.env`; matching folds that rule's candidate and patterns but
does not change the Git path or override identity.
