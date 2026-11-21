# Community decks for the SWU offline practice app — dropdown seed

Prepared 2026-11-20 (evening) for the swu-forge-app build (see PLAN.md, stage 3/4).
Purpose: the "top community deck builds" dropdown Tyler asked for — decks to
practice AGAINST with the AI. The updater refreshes this list from the same
source; if offline it keeps this seed.

## Source

- Meta index: https://sw-unlimited-db.com/meta/
- Updated 15 Nov 2026; data range 10 Oct – 15 Nov 2026; 2,011 decks, 40 events,
  33 leaders ranked. Tournament data from melee.gg.
- Format of these lists: Standard (= Premier) tournament decks. They are
  practice opponents, not Tyler's decks — his four decks stay Eternal and
  pre-loaded separately (below).

## Verified top decks (first "Top meta decks" entry per leader page)

Each URL was opened and verified 2026-11-20. Prices are the site's paper
singles estimate — irrelevant for AI practice, shown only because the Wicket
list is strikingly cheap. All four are Standard 50-card mains + 10-card
sideboard; the app plays the 50-card main only (drop the sideboard on import).

1. **Wicket, Few Greater Battles to Fight — Imperial Command Complex** (S tier)
   https://sw-unlimited-db.com/decks/172244 — $52.08
   Swarm aggro; won the Utrecht Regionals. Cheapest top list on the page.
2. **Doctor Hemlock, Emotion Has No Place Here — Data Vault** (S tier)
   https://sw-unlimited-db.com/decks/172090 — $295.09
3. **Director Krennic, Amidst My Achievement — Great Grass Plains** (S tier)
   https://sw-unlimited-db.com/decks/170971 — $280.88
   Regional-crushing control list; runs Chimaera, Ravager, Palpatine.
4. **Ahsoka Tano, Trust In The Force — Mos Eisley** (S tier)
   https://sw-unlimited-db.com/decks/169769 — $139.31

## Full S/A tier table (from the meta index — updater seed)

| Tier | Leader | Win rate | Meta share | Decks | Events |
|------|--------|----------|------------|-------|--------|
| S | Wicket, Few Greater Battles to Fight | 54% | 11.0% | 221 | 31 |
| S | Doctor Hemlock, Emotion Has No Place Here | 54% | 9.0% | 180 | 31 |
| S | Director Krennic, Amidst My Achievement | 53% | 9.6% | 194 | 30 |
| S | Ahsoka Tano, Trust In The Force | 51% | 11.4% | 230 | 33 |
| S | Mother Talzin, Power Through Magick | 53% | 3.5% | 71 | 23 |
| S | Dedra Meero, Not Wasting Time | 53% | 2.1% | 43 | 19 |
| A | Lando Calrissian, Full Sabacc | 52% | 4.0% | 81 | 22 |
| A | Darth Maul, Sith Revealed | 52% | 3.7% | 74 | 24 |
| A | Han Solo, Never Tell Me The Odds | 52% | 1.8% | 37 | 15 |
| A | Boba Fett, Any Methods Necessary | 50% | 5.7% | 115 | 27 |
| A | Sabine Wren, Bargaining On Belief | 53% | <1% | 11 | 5 |
| A | Kazuda Xiono, Best Pilot in the Galaxy | 52% | <1% | 20 | 13 |
| A | Darth Vader, Victor Squadron Leader | 49% | 4.3% | 87 | 28 |

Leader pages live at https://sw-unlimited-db.com/meta/leaders/<slug>
(verified pattern, e.g. …/wicket-few-greater-battles-to-fight).
Updater rule: for each S/A leader, take the first entry under "Top meta
decks" on its leader page, fetch its /decks/<id> list, keep the 50-card main.

## Tyler's own decks — pre-load as the player side

SWUDB JSON, in ~/workspace/goals/star-wars-unlimited-decks-and-collection/files/:
- vader-deck-holoscan.json (Vader, Unstoppable / Coaxium Mine)
- jabba-deck-holoscan.json (Jabba, Crime Boss / Daimyo's Palace)
- trance-deck-holoscan.json (Trance — Palpatine Recursion / Canto Bight)
- rites-deck-holoscan.json (Rites — Thrawn Death Payoffs / Stygeon Spire)

## Notes / honest caveats

- These are Premier tournament lists from the Homeworlds era (current set);
  some cards are new and pricey on paper — that does not matter for a free
  AI opponent, but do not present the dollar figures as a buy list.
- Tyler's Rites leader (Grand Admiral Thrawn, …How Unfortunate) sits C tier
  in this same table: 48% win rate, 1.7% share, 35 decks. That is fine — his
  Thrawn deck is a Blood Rites analogue built for the drain feel, not a
  ladder pick. Do not "fix" it toward the meta unless he asks.
- The meta table will move as Homeworlds settles; that is exactly what the
  update-on-launch refresh is for. This file is the seed, not the final list.
