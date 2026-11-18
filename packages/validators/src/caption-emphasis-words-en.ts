/**
 * English word lists for the caption emphasis scorer (`caption-emphasis.ts`).
 * Hand-written closed classes, space separated to keep the browser bundle small.
 * Entries are normalised the same way as transcript words before lookup.
 */
export const CAPTION_EMPHASIS_EN = {
  /** Closed-class words: determiners, pronouns, auxiliaries, prepositions, conjunctions. */
  minor:
    "a an the this that these those each some any such what which whose whom who whoever whatever " +
    "i me my mine myself you your yours yourself yourselves he him his himself she her hers herself " +
    "it its itself we us our ours ourselves they them their theirs themselves " +
    "someone somebody something anyone anybody anything " +
    "i'm i've i'll i'd you're you've you'll you'd he's he'll he'd she's she'll she'd it's it'll " +
    "we're we've we'll we'd they're they've they'll they'd that's there's here's what's who's let's " +
    "am is are was were be been being have has had having do does did doing " +
    "will would shall should can could may might must ought gonna wanna gotta " +
    "of to in on at by for with from into onto upon about above below over under between among " +
    "through during before after since until till against without within along across around " +
    "behind beyond near toward towards via per off out up down as than " +
    "and or but so yet if because though although while whereas unless whether then also " +
    "there here when where why how too other another more most",
  /** Discourse words: render as body, never the hero. */
  filler:
    "like basically literally actually honestly um umm uh uhh uhm er erm hmm mm mhm ah oh " +
    "okay ok yeah yep yup well anyway anyways kinda sorta right alright just really very",
  negation:
    "not no never nothing nobody none nowhere neither nor cannot can't don't doesn't didn't " +
    "won't wouldn't shouldn't couldn't isn't aren't wasn't weren't haven't hasn't hadn't ain't mustn't",
  number:
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen " +
    "sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety " +
    "hundred hundreds thousand thousands million millions billion billions trillion " +
    "half double twice triple dozen",
  /** About 80 words that carry the punch of a spoken line. */
  power:
    "secret secrets mistake mistakes truth free money best worst biggest huge massive insane crazy " +
    "amazing incredible shocking dangerous deadly brutal perfect ultimate powerful proven guaranteed " +
    "instantly immediately forever always everything everyone everybody only first last new now " +
    "today finally exactly impossible easy simple hard fast faster quickly rich broke wealth success " +
    "successful fail failed failure win winning lose losing lost love hate fear scared dead die death " +
    "kill wrong problem danger warning stop important critical real life rule rules hack trick myth " +
    "lie lies changed game",
  /** Unit and scale words that join a preceding number into one hero. */
  unit:
    "percent percentage million millions billion billions thousand thousands k x dollar dollars " +
    "rupee rupees lakh lakhs crore crores year years day days hour hours minute minutes second " +
    "seconds time times",
} as const;
