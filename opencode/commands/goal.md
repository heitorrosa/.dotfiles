---
description: Set, inspect, pause, resume, or clear a persistent goal (runs until achieved)
---

Handle the /goal command based on $ARGUMENTS:

1. **No arguments** → call the `goal_get` tool and show the result to the user.
2. **`pause`** → call `goal_control` with action `pause`.
3. **`resume`** → call `goal_control` with action `resume`.
4. **`clear`** → call `goal_control` with action `clear`.
5. **Anything else** → treat ALL of $ARGUMENTS as the objective and call `goal_create` with it verbatim. Do not shorten or rewrite the objective — pass it through unchanged. Then follow the instructions returned by `goal_create` and begin working toward the goal immediately.

Never narrate this dispatch logic; just execute it.
