import type { EvalScript } from "./fixtures";

// Written transcripts whose lines say a phrase badge's moment (both of its parts, or the words of
// its name), mixed with lines that name only one part: the eval's other transcripts almost never
// say one, so these measure whether the tagger picks a badge where it fits and a single emoji where
// it does not. Reported apart from the written sets (ticket 23).

export const MOMENTS: readonly EvalScript[] = [
  {
    id: "en-moments", language: "en", genre: "moments (badges)", title: "A slow Saturday",
    text: `Okay, first things first, time for my morning coffee.
I love coffee, but I only drink one cup a day.
After six hours of climbing we finally reached the summit.
On the way down my shoes got completely soaked in the rain.
It is so hot today, so keep drinking water and stay hydrated.
The bus left right in front of me, so I had to run to catch the next one.
Back home, my cat was asleep in a cardboard box again.
I bought a small plant for the kitchen window.
Tomorrow is launch day for our new app, so I am a little nervous.
Pizza and a movie tonight, who is in?
I dropped my phone and the screen cracked.
My package was delivered right to my door this morning.
It is my sister's birthday, so we lit the candles and she made a wish.
I walked the dog before it got dark.
Honestly, time flies when you are having fun.
I ate one donut and that was enough.`,
  },
  {
    id: "ur-moments", language: "ur", genre: "moments (badges)", title: "میری چھٹی کا دن",
    text: `صبح کی کافی کے بغیر میرا دن شروع ہی نہیں ہوتا۔
مجھے چائے بھی پسند ہے لیکن دن میں ایک ہی کپ۔
چھ گھنٹے چڑھنے کے بعد آخرکار ہم پہاڑ کی چوٹی تک پہنچ گئے۔
واپسی پر بارش میں میرے جوتے پورے بھیگ گئے۔
گرمی بہت ہے، پانی پیتے رہیں۔
بس میرے سامنے نکل گئی تو مجھے بھاگ کر اگلی پکڑنی پڑی۔
گھر آیا تو میری بلی پھر سے گتے کے ڈبے میں سو رہی تھی۔
کل ہماری نئی ایپ کا launch day ہے۔
آج رات پیزا اور فلم، کون کون آ رہا ہے؟
میرا فون گر گیا اور اس کی سکرین ٹوٹ گئی۔
آج میری بہن کی سالگرہ ہے، اس نے موم بتیاں بجھا کر دعا مانگی۔
اندھیرا ہونے سے پہلے میں کتے کو سیر کروا لایا۔`,
  },
];
