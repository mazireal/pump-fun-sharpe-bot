# Pump.fun Sharpe Bot

[![make.fun competition](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/mazireal/pump-fun-sharpe-bot/rank.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/mazireal/pump-fun-sharpe-bot/reward.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the make.fun [Pump.fun Sharpe Sprint](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532), where entries are ranked by hourly Sharpe ratio on a 6-hour pump.fun replay.

## Strategy

"Rally Rider, pump.fun edition" keeps the trading deliberately plain:

- Buys only young bonding curves, shortly after launch, once the curve can absorb the stake under the replay's size cap.
- Every entry stakes a flat 0.10 SOL; at most five positions are open at once.
- Exits are mechanical: take profit at +20%, hard stop at −8%, a trailing stop 10% below the peak value once the position is ahead, and a 600-slot maximum holding time.
- No randomness, no clock, no environment reads: the same replay always produces the same orders.

## Layout

- `main.ts` — the strategy, run by the grader with Node 22.
- `vendor/makefun-bot.ts` — the replay protocol shim from the competition kit.
- `.makefun/owner.json` — the entry wallet claim file.

## License

MIT. See [LICENSE](LICENSE).
