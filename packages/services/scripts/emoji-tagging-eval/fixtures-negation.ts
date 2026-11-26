import type { EvalScript } from "./fixtures";

// Negation in the emoji relevance evaluation (ticket 27). Written transcripts whose lines say a
// thing is absent, denied or advised against, often far from the noun, beside lines that only sound
// negative ("no doubt the camera is great") and must keep their emoji. Reported apart from the
// written sets, like the badge moments.

export const NEGATION: readonly EvalScript[] = [
  {
    id: "en-negation", language: "en", genre: "travel vlog (negation)", title: "Our worst and best day in Lisbon",
    text: `No doubt the camera on this new phone is great, look at these shots.
We waited outside the bakery for forty minutes in the cold and there was, after all that, no bread left.
Without a doubt, this is the best coffee I have had all year.
In twenty years of asking, this family has never once had a dog.
We did not bring an umbrella, so we got completely soaked in the rain.
Nothing beats a cold shower after a long walk up these hills.
You honestly do not need an expensive drone to film a trip like this.
I can't stop eating these little custard tarts.
Not a single taxi, not one, stopped for us on the way back.
I didn't expect the beach to be this beautiful.`,
  },
  {
    id: "ur-negation", language: "ur", genre: "daily vlog (negation)", title: "ایک عجیب سا دن",
    text: `اس میں کوئی شک نہیں کہ اس فون کا camera کمال کا ہے۔
سارا دن بازار میں گھومے، ہر دکان دیکھی، لیکن آم کہیں بھی نہیں ملے۔
میرے پاس گاڑی نہیں ہے، اس لیے میں روز bus سے آتا ہوں۔
چائے کے بغیر میری صبح شروع ہی نہیں ہوتی۔
گھر آیا تو فریج میں ایک بھی انڈا نہیں بچا تھا۔
بارش میں چھتری کے بغیر نکلنا میری سب سے بڑی غلطی تھی۔`,
  },
  {
    id: "ar-negation", language: "ar", genre: "daily vlog (negation)", title: "يوم طويل في المدينة",
    text: `لا شك أن القهوة في هذا المقهى رائعة.
انتظرنا ساعتين تحت المطر، ولم تصل الحافلة أبدا.
ليس عندي سيارة، لذلك أمشي إلى العمل كل يوم.
لا أحد يستطيع أن يقاوم رائحة الخبز الطازج في الصباح.
بحثنا في كل المطاعم القريبة ولم نجد بيتزا واحدة مفتوحة.`,
  },
  {
    id: "hi-negation", language: "hi", genre: "food vlog (negation)", title: "आज का खाना",
    text: `इसमें कोई शक नहीं कि ये pizza शहर का सबसे अच्छा है।
घर में एक भी अंडा नहीं बचा था, तो नाश्ता biscuit से किया।
मैंने आज तक कभी sushi नहीं खाई है।
चाय के बिना मेरा दिन शुरू ही नहीं होता।`,
  },
];

/**
 * Words whose emoji is wrong because the line says the thing is absent, lacking, not needed or not
 * happening (`absent`) or tells the viewer not to have it (`advised`, reported apart: a softer
 * case), and words that must keep a pick because the line only sounds negative (`present`), as
 * `line:word` with the line's index in the transcript and the word as written (compared with
 * `captionWordComparable`); `#n` picks the word's nth occurrence on the line. Covers the written
 * fixtures with negated nouns (ticket 21's nine), the transcripts above and the real clips'
 * "no telephoto camera" and "missing features".
 */
export const NEGATION_TARGETS: Readonly<Record<string, { readonly absent: readonly string[]; readonly advised?: readonly string[]; readonly present?: readonly string[] }>> = {
  "en-tech": { absent: ["5:cartoonish", "9:charger", "9:box", "10:stutter", "14:charger", "14:box"] },
  "ur-business": { absent: ["1:منافع", "1:کمی#2", "6:حساب", "6:کتاب"] },
  "ur-comedy": { absent: ["11:gym", "11:دروازہ"] },
  "ur-fitness": { absent: ["11:gym", "11:ضرورت"], advised: ["4:کولڈ", "4:ڈرنک", "4:مٹھائی", "4:دوستی"] },
  "hi-business": { absent: ["1:पैसे", "1:कमी#2", "8:use"], advised: ["2:fancy", "2:office", "4:full", "4:time", "4:employee"] },
  "hi-tech": { absent: ["7:Gaming"] },
  "hi-fitness": { absent: ["0:gym", "0:time", "10:perfect"] },
  "ar-business": { absent: ["1:الربح", "1:ينقصهم#2", "6:تكتب", "6:حساباتك"] },
  "ar-tech": { absent: ["2:شاحن", "7:ينقطع"] },
  "en-negation": {
    absent: ["1:bread", "3:dog", "4:umbrella", "6:drone", "6:expensive", "8:taxi"],
    present: ["0:camera", "2:coffee", "5:shower", "7:custard", "7:tarts", "9:beach"],
  },
  "ur-negation": { absent: ["1:آم", "2:گاڑی", "4:انڈا", "5:چھتری"], present: ["0:camera", "3:چائے"] },
  "ar-negation": { absent: ["1:الحافلة", "2:سيارة", "4:بيتزا"], present: ["0:القهوة", "3:الخبز"] },
  "hi-negation": { absent: ["1:अंडा", "2:sushi"], present: ["0:pizza", "3:चाय"] },
  "urdu-direction": { absent: ["6:missing", "6:features", "7:telephoto", "7:camera#1", "7:face", "7:ID"] },
  "hi-matte": { absent: ["2:missing", "2:features"] },
};
