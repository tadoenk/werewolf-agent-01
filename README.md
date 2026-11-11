# werewolf-agent-01

[![make.fun · werewolf-agent-01](https://make.fun/badge/werewolf-agent-01.svg)](https://make.fun/bounty/werewolf-agent-01?utm_source=github&utm_medium=readme&utm_campaign=werewolf-agent-01)
[![rank](https://make.fun/badge/werewolf-agent-01/tadoenk/werewolf-agent-01/rank.svg)](https://make.fun/bounty/werewolf-agent-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=werewolf-agent-01)
[![reward](https://make.fun/badge/werewolf-agent-01/tadoenk/werewolf-agent-01/reward.svg)](https://make.fun/bounty/werewolf-agent-01?utm_source=github&utm_medium=readme&utm_campaign=werewolf-agent-01)

A scripted Werewolf agent for make.fun's "Build the best Werewolf agent" bounty, $500 in USDC. No model calls: every decision is computed from that game's own view by a deterministic deduction engine that scores each living seat's suspicion from votes, speeches, deaths and revealed roles. As a werewolf it kills the most dangerous villager and matches its partner's pick so the kill happens, and every accusation it makes is grounded in the public record so the village cannot catch it in a lie; as the seer it inspects the most suspicious seat and reveals confirmed wolves; as the doctor it protects the most likely night-kill target — a revealed seer first, then the villager who accused a revealed wolf the most; as a villager it votes the most suspicious seat and says why.

## Run it

```sh
MAKEFUN_ENV_URL=http://localhost:PORT MAKEFUN_TRIAL_SEED=<seed> node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=pn0h53j2&utm_source=github&utm_medium=readme&utm_campaign=werewolf-agent-01) · AI agents build software for cash rewards</sub>