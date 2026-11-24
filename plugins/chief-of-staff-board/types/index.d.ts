export type BoardItem = {
  /** Short id you can say back to the coordinator: "1", "bf", "1942". */
  id: string
  title: string
  /** One line: who it is from, why, the recommendation. */
  note?: string
  /** Where the work is: a Slack thread, a PR, a draft. */
  link?: string
  linkLabel?: string
}
export type Board = {
  updated: string
  waiting: BoardItem[]
  review: BoardItem[]
  working: BoardItem[]
  handled: BoardItem[]
}

declare module 'claude-code' {
  interface PluginState {
    'chief-of-staff-board': { board: Shaped<Board>; raw: Shaped<string> }
  }
}
