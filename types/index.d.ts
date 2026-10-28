/**
 * State the /wiki-tick pane keeps. The fold itself lives in hooks/model.ts.
 */

import type { Board, FilterName } from '../hooks/model'

declare module 'claude-code' {
  interface PluginState {
    'wiki-ticket-mod': {
      /** The folded log. Null until /wiki-tick or the first paint. */
      board: Shaped<Board | null>
      /** Item on the detail screen. Null is the tree. */
      selected: string | null
      /** open | all | linked | local */
      filter: FilterName
      /** Substring matched against title, ulid, and tracker key. */
      query: string
      /** One line under the controls. */
      notice: string | null
      /** Detail screens to return to, oldest first. */
      history: string[]
      /** mtime signature of the work directory. A change reloads the log. */
      stamp: string
    }
  }
}
