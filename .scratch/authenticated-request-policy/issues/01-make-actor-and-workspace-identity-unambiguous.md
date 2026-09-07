# 01 — Make actor and Workspace identity unambiguous

**What to build:** Replace the ambiguous authenticated-user shape in one direct mechanical cutover. Every browser-session caller must receive the signed-in App User and active Workspace context as separately named facts. The signed-in user ID must always identify the person who acted. Workspace owner identity may be passed only under an explicit owner-specific name where a current domain interface still requires it. Existing successful behavior must remain unchanged while audit and ownership arguments become reviewable.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] The authenticated identity shape no longer rewrites a generic user ID to the Workspace owner.
- [x] Signed-in actor ID, Workspace ID, Workspace owner ID, role, status, tier, and personal-Workspace status have distinct names and cannot be substituted through structural ambiguity.
- [x] A collaborative-Workspace test proves that the actor and owner remain different through an authenticated request and an audit-aware domain call.
- [x] Rate-limit and audit keys that identify a person use the signed-in actor, while Workspace-scoped limits use the Workspace ID.
- [x] Current domain calls receive explicit actor and Workspace scope. Any owner-specific argument that remains is named as such and is not exposed as the request user.
- [x] The old compatibility identity shape is removed in the same change. There is no dual helper, alias, or fallback identity path.
- [x] Existing authenticated pages, routes, actions, and streams retain their current success behavior after the mechanical cutover.
- [x] Focused identity tests, repository typecheck, and repository tests pass.
