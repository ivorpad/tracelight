# Learning patterns

Five investigations that answer the questions people ask about code they did not write. Use the
one the current question needs. None is a stage the learner has to pass through, and a new
question switches pattern at once.

Each pattern is worked on `examples/js/checkout`, a service in four files. `main.ts` picks a
payment gateway by country and injects it into `CheckoutService` (`checkout.ts`), which prices
an order, charges it through whatever gateway it holds, and publishes `order.paid` on an
`EventBus` (`events.ts`) that delivers it on a later turn of the event loop. The output below is
what these commands print, trimmed where marked. `node/test/learning-scenarios.test.ts` drives the
same routes (the page's live debugger runtime and `tracelight mcp`), so a change that breaks one
of these answers fails there.

| the question sounds like | pattern | first stop |
|---|---|---|
| "which `charge` runs?", "what does this interface call do here?" | [actual implementation](#actual-implementation) | the call site, then Step Into |
| "where does 153.47 come from?", "why is this value wrong?" | [value provenance](#value-provenance) | where the value is used |
| "who decides invoice or card?", "who owns this state?" | [decision and state ownership](#decision-and-state-ownership) | the branch or assignment, before it runs |
| "when is the receipt sent, and by whom?" | [async handoff](#async-handoff) | the receiving handler |
| "what changes for a US customer?" | [contrast](#contrast) | two real runs that differ in one condition |

The recordings below come from the real entry, saved outside the repository:

```sh
cd examples/js/checkout
tracelight run main.ts --save "$S/de.json" -- --country de
tracelight run main.ts --save "$S/us.json" -- --country us
```

## Actual implementation

`checkout.ts:46` reads `const charge = await this.gateway.charge(total, currency);`. The field is
typed `PaymentGateway`, an interface with two implementations in `payments.ts`, so the source
cannot say which `charge` runs for a given order. Enter the call:

```sh
tracelight debug main.ts --at checkout.ts:46 --args --country de
tracelight step --live --into
tracelight eval --live this
```

The pause at line 46 holds `total = 153.47` and `currency = 'EUR'`, and `charge` is still
undefined because the statement has not run. Step Into lands at `payments.ts:29` in a frame
named only `charge`, under `placeOrder`. Stack frames carry no class name, so the file and line
say which class this is, and `this` confirms it: `InvoiceGateway { dueDays: 14 }`. When `this` is
missing from the locals (the page's debugger leaves it out), evaluate it. Over the recording the
same move answers in one reply:

```
$ tracelight step de.json 37 --into
from step 37
step 38/66  payments.ts:29  charge [entry]
stack: charge payments.ts:29 #38 ← placeOrder checkout.ts:46 #37 ← <module> main.ts:44 #28
...
  #39 payments.ts:30  this = InvoiceGateway { dueDays: 14 }
```

That is the runtime answer for this input. The wiring question comes next: who put an
`InvoiceGateway` in `this.gateway`? The source says `main.ts:35` passes `gatewayFor(country)` to
the constructor, which stores it at `checkout.ts:36`. The run confirms that reading instead of
leaving it as one: `walkthrough de.json` shows `#18 call to gatewayFor from <module>` with
`in country = 'de'` and `out return = InvoiceGateway { dueDays: 14 }`, and the constructor
receiving `gateway = InvoiceGateway { dueDays: 14 }`. Keep the two kinds of claim apart when you
explain it. Observed: this order's call reached `InvoiceGateway.charge` with 153.47 EUR. Read in
source: every German order gets the same gateway, because `gatewayFor` reads nothing but the
country. `CardGateway.charge` did not run here; describe it from source if asked, and say so.

A registered callback asks the same question: which function did the runtime call? On the page,
a function value's captured `functionSource` and `functionLocation` identify it
([browser.md](browser.md)). A parameter's declared type does not.

## Value provenance

Start where the value is used, then walk back to its inputs. The gateway is charged `total`:

```
$ tracelight why de.json 37 total
why total at #37
total = 153.47   #35 checkout.ts:44 placeOrder   const total = Math.round(subtotal * (1 - discount) * (1 + taxRate) * 100) / 100;
  ← subtotal = 128.97   #30 checkout.ts:41 placeOrder   const subtotal = cart.lines.reduce((sum, line) => sum + line.qty…(+18 chars)
    ↳ <arrow> #31–#31 checkout.ts:41   in sum = 0, line = { sku: 'KB-01', qty: 2, price: 49.5 }   out 99
    ↳ <arrow> #32–#32 checkout.ts:41   in sum = 99, line = { sku: 'USB-C', qty: 3, price: 9.99 }   out 128.97
    · cart.lines.reduce((sum, line) => sum + line.qty * line.price, 0)   not stepped
  ← discount = 0   #33 checkout.ts:42 placeOrder   const discount = COUPONS[cart.coupon] ?? 0;
    ← COUPONS = { WELCOME10: 0.1 }   #1 checkout.ts:26 <module>   const COUPONS: Record<string, number> = { WELCOME10: 0.1 };
  ← taxRate = 0.19   #34 checkout.ts:43 placeOrder   const taxRate = TAX[cart.country] ?? 0;
    ← TAX = { us: 0.07, de: 0.19, nl: 0.21 }   #2 checkout.ts:27 <module>   const TAX: Record<string, number> = { us: 0.07, de: 0.19, nl: 0.21 };
  · Math.round(subtotal * (1 - discount) * (1 + taxRate) * 100)   not stepped
total is 153.47 at #35 (checkout.ts:44). It reads subtotal = 128.97, discount = 0, taxRate = 0.19.
```

(The three `← cart = …` lines are left out.) So 153.47 is 128.97 × 1.19 rounded to cents: the
cart's two lines, no discount because the cart's coupon is `''`, and German VAT. A `not stepped`
line is a call into code the recorder did not instrument, here the built-ins `reduce` and
`Math.round`. Its result is in the chain and its insides are not. Then follow the value forward:
`InvoiceGateway.charge` receives `amount = 153.47` (`#37`), the reference becomes
`inv-14d-15347`, and the receipt handler prints `153.47 EUR by invoice`.

A live pause has the values but no chain behind them unless that execution was recorded (the
page's debugger records it for Code history, VS Code needs `--record`). Without a recording,
read the inputs at the producer's line in the same run, a breakpoint at `checkout.ts:44`, or
record the scenario and ask `why`. When the question is about another input ("and with the
coupon?"), run the real entry with it: `main.ts --country de --coupon WELCOME10` prints `placed
ord-1 138.13 EUR inv-14d-13813`. Computing that from the source and presenting it as observed
is the mistake this pattern exists to avoid.

## Decision and state ownership

A decision has operands, the arm that ran, and a consequence. Pause before the branch, read the
operands, step, and read what followed. With `--at gatewayFor --args --country de`, step to the
`if` at `payments.ts:36`, where `country = 'de'`, then Step Into until the frame changes. The
pause lands in a frame named `constructor` at `payments.ts:25` with `dueDays = 14` and the stack
`constructor ← gatewayFor ← <module>`. The file and line make that `InvoiceGateway`'s
constructor, so the true arm ran. `walkthrough de.json` records the same two facts as
`#20 if (country === 'de' || country === 'nl') took true` and `#21 call to
InvoiceGateway.constructor from gatewayFor` with `in dueDays = 14`.

Then connect it to the responsibility, which is usually what the learner is asking about. The
payment method is decided once, by `gatewayFor`, while `main.ts` wires the service. `placeOrder`
never looks at the country to choose how to charge. It reads the country only for the tax rate
(`checkout.ts:43`) and the currency (`checkout.ts:45`). The gateway is state that
`CheckoutService` owns: a `readonly` field set in its constructor (`checkout.ts:36`). The order
counter `nextOrder` (`checkout.ts:29`) is module state, so order numbers restart with each
process. Those two are facts from source. A run shows them holding once, not that nothing else
could change them.

For a mutation the order is the same: read the object before the statement, step over it, read
it again. In a recording a `(same object)` binding is not a snapshot taken after the mutation
([explain.md](explain.md#exploring-a-recording)).

## Async handoff

`placeOrder` publishes `order.paid` at `checkout.ts:48` and returns. The receipt goes out later,
from another stack:

```
$ tracelight context de.json 62
step 62/66  main.ts:25  sendReceipt
stack: sendReceipt main.ts:25 #62 ← flush events.ts:27 #60 ← <arrow> events.ts:18 #52 ← <module> main.ts:46 #48
```

No `placeOrder` frame. `publish` queued the event and scheduled `flush` with `setImmediate`
(`events.ts:17`), `placeOrder` returned, and `main.ts` printed `placed ord-1 153.47 EUR
inv-14d-15347` at `#47`, before the handler started at `#61`. The `<module> main.ts:46 #48` at the
bottom is not a caller. The recorder files a callback that the event loop entered under the module
scope at that scope's last step (`await bus.idle()`), and `walkthrough` lists it as `#48 call to
EventBus.<arrow> from <module>`. No verb prints which call scheduled it. Join the two sides by the
source (`events.ts:17`) and by what crossed: `publish` at `#41` and `sendReceipt` at `#61` carry the
same event, `orderId: 'ord-1'`, `total: 153.47`.

Live, a breakpoint at `main.ts:25` pauses with `sendReceipt main.ts:25 ← flush events.ts:27 ←
<arrow> events.ts:18 ← <module>`, the module frame without a line. Say that the stack starts at
the event loop.

An HTTP request inside one process looks the same. `examples/js/rrf/api/server.ts --once` posts to
itself, and the handler's stack starts at the server's request listener, not at the client:
`rrf ranking.ts:9 #26 ← rank server.ts:34 #25 ← handle server.ts:65 #16 ← <arrow> server.ts:80 #9 ←
<module> server.ts:84 #5`. The client's `fetch` at `server.ts:86` is waiting on a different stack.
Across processes, queues and workers each side has its own stack and often its own recording.
Join them by what crosses the boundary (a request body, an order id, a message), and do not draw
one continuous stack through it.

## Contrast

To see what a condition changes, keep the entry point and fixtures and change that one condition.
Both runs here put the same cart through `main.ts`, and only `--country` differs:

```
$ tracelight diff us.json de.json
a  us.json  main.ts  65 steps  exit 0
b  de.json  main.ts  66 steps  exit 0
statements: 74 same, 0 edited, 0 added, 0 removed (matched by file, function and text)
20 statements did something different; the first at main.ts:30 (a#6  b#6)
main.ts:30  <module>  const country = option('country', process.env.CHECKOUT_COUNTRY ?? 'us');
  country = 'us' → 'de'   a#6  b#6
...
payments.ts:36  gatewayFor  if (country === 'de' || country === 'nl') return new InvoiceGateway(14);
  took false → true   a#20  b#20
...
checkout.ts:43  CheckoutService.placeOrder  const taxRate = TAX[cart.country] ?? 0;
  taxRate = 0.07 → 0.19   a#32  b#34
...
checkout.ts:46  CheckoutService.placeOrder  const charge = await this.gateway.charge(total, currency);
  call CardGateway.charge(amount=138, currency='USD')   only in a   a#35
  call InvoiceGateway.charge(amount=153.47, currency='EUR')   only in b   b#37
...
main.ts:45  <module>  console.log('placed', receipt.orderId, receipt.total, receipt.currency, receipt.reference);
  printed placed ord-1 138 USD card-13800 → placed ord-1 153.47 EUR inv-14d-15347   a#46  b#47
```

The first difference is the input you changed, which tells you nothing new. The first meaningful
divergence is `payments.ts:36`, the branch that took the other arm, and the tax rate, the gateway
called and the printed line follow from it. Both sides went through the real wiring, so the diff
shows that `main.ts` injects a different gateway and that the call at `checkout.ts:46` reaches it.
Each side's step opens that moment: `tracelight step us.json 35 --into` lands in
`CardGateway.charge` at `payments.ts:15`. Live, the same contrast is a second debug run with the
other argument, and that run executes the program again, side effects included.

The scratchpad complements this, and its results are labelled as scratchpad results. A copy of
`placeOrder` with a mocked gateway can show what the arithmetic gives for `nl` while the live
program stays paused and nothing runs twice. It cannot show that the application calls
`placeOrder` that way, that `main.ts` injects that gateway, or what the receipt handler does with
the result. Say "scratchpad, gateway mocked" next to anything it produced
([scratchpad.md](scratchpad.md)).

## Traps these runs show

Stack frames carry no class (`charge`, `constructor`). `walkthrough` and `diff` do
(`InvoiceGateway.charge`), and so does `this`.

A live pause shows the values before the highlighted statement runs. The statement's result
exists after the step.

A callback the event loop entered sits under `<module>` at that scope's last step, and `from
<module>` in a walkthrough means the same. The scheduler is not printed.

A diff's first difference is usually the condition you changed. Read on to the first branch or
call that differs.

A branch that did not run is no evidence of what it does. `payments.ts:16`, the `amount <= 0`
throw, took false in the US run and never ran in the German one.
