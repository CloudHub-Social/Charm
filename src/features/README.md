# Feature-local state conventions

Most feature state is local `useState`/`useReducer` scoped to whatever
component owns it — that should stay the default.

Reach for a Jotai atom-family (see `room-info/roomInfoAtoms.ts`,
`rooms/messageActionAtoms.ts`) instead, keyed by `roomId` (or whatever entity
the state belongs to), only when the state needs one of:

- **To persist across a remount** — e.g. `ChatShell` unmounting/remounting as
  the user switches rooms shouldn't reset an in-progress reply/edit for a room
  they're not currently viewing.
- **To be shared across sibling components that don't have a natural common
  parent to lift plain `useState` into** — e.g. the room-info drawer and the
  message list both need to agree on whether the members drawer is open for a
  given room.

If neither applies, use local `useState`/`useReducer`. `ChatShell.tsx` mixes
both in the same component deliberately: `messages`/`loading`/`uploads` etc.
are local because they don't need to survive a remount or be read by a
sibling, while `replyTarget`/`editingEventId`/`membersDrawerOpen` are
atom-families for the reasons above.

See https://github.com/CloudHub-Social/Charm/issues/70 for the discussion
that prompted this note.
