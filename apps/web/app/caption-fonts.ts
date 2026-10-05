import localFont from "next/font/local";

// Caption fonts — the SAME files the worker hands to libass for burn-in
// (packages/caption-fonts/fonts), one static face per catalog entry in
// packages/validators/src/caption-font.ts. next/font requires literal options,
// so the metric overrides below are written out; caption-fonts.test.ts checks
// them against the catalog. ascent-override / descent-override force the
// browser onto the faces' OS/2 win metrics, the line box libass uses, so a
// caption line has the same height and baseline in preview and export.
//
// `preload: false` on every face is deliberate: the variables are declared
// on <html> so the studio can resolve them, but the faces are only ever used
// in caption surfaces, and next/font preloads root-layout fonts on every route.

const captionAnton = localFont({
  src: "../../../packages/caption-fonts/fonts/Anton-Regular.ttf",
  weight: "400",
  style: "normal",
  variable: "--font-caption-anton",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "140.43%" },
    { prop: "descent-override", value: "32.91%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionArchivoBlack = localFont({
  src: "../../../packages/caption-fonts/fonts/ArchivoBlack-Regular.ttf",
  weight: "400",
  style: "normal",
  variable: "--font-caption-archivo-black",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "103.5%" },
    { prop: "descent-override", value: "31.2%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionBebasNeue = localFont({
  src: "../../../packages/caption-fonts/fonts/BebasNeue-Regular.ttf",
  weight: "400",
  style: "normal",
  variable: "--font-caption-bebas-neue",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "95%" },
    { prop: "descent-override", value: "35%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionBricolageGrotesque = localFont({
  src: "../../../packages/caption-fonts/fonts/BricolageGrotesque-ExtraBold.ttf",
  weight: "800",
  style: "normal",
  variable: "--font-caption-bricolage-grotesque",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "116%" },
    { prop: "descent-override", value: "40%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionChakraPetch = localFont({
  src: "../../../packages/caption-fonts/fonts/ChakraPetch-Bold.ttf",
  weight: "700",
  style: "normal",
  variable: "--font-caption-chakra-petch",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "124.8%" },
    { prop: "descent-override", value: "56.6%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionCourierPrime = localFont({
  src: "../../../packages/caption-fonts/fonts/CourierPrime-Bold.ttf",
  weight: "700",
  style: "normal",
  variable: "--font-caption-courier-prime",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "92.77%" },
    { prop: "descent-override", value: "39.06%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionDelaGothicOne = localFont({
  src: "../../../packages/caption-fonts/fonts/DelaGothicOne-Regular.ttf",
  weight: "400",
  style: "normal",
  variable: "--font-caption-dela-gothic-one",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "116%" },
    { prop: "descent-override", value: "28.8%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionInstrumentSerif = localFont({
  src: "../../../packages/caption-fonts/fonts/InstrumentSerif-Italic.ttf",
  weight: "400",
  style: "italic",
  variable: "--font-caption-instrument-serif",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "99%" },
    { prop: "descent-override", value: "31%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionInter = localFont({
  src: "../../../packages/caption-fonts/fonts/Inter-ExtraBold.ttf",
  weight: "800",
  style: "normal",
  variable: "--font-caption-inter",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "110.79%" },
    { prop: "descent-override", value: "32.23%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionInterSemiBold = localFont({
  src: "../../../packages/caption-fonts/fonts/Inter-SemiBold.ttf",
  weight: "600",
  style: "normal",
  variable: "--font-caption-inter-semibold",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "110.79%" },
    { prop: "descent-override", value: "32.23%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionLilitaOne = localFont({
  src: "../../../packages/caption-fonts/fonts/LilitaOne-Regular.ttf",
  weight: "400",
  style: "normal",
  variable: "--font-caption-lilita-one",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "92.3%" },
    { prop: "descent-override", value: "22%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionLuckiestGuy = localFont({
  src: "../../../packages/caption-fonts/fonts/LuckiestGuy-Regular.ttf",
  weight: "400",
  style: "normal",
  variable: "--font-caption-luckiest-guy",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "97.95%" },
    { prop: "descent-override", value: "24.61%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionMontserrat = localFont({
  src: "../../../packages/caption-fonts/fonts/Montserrat-Black.ttf",
  weight: "900",
  style: "normal",
  variable: "--font-caption-montserrat",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "110.9%" },
    { prop: "descent-override", value: "45.3%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionOpenSans = localFont({
  src: "../../../packages/caption-fonts/fonts/OpenSans-Bold.ttf",
  weight: "700",
  style: "normal",
  variable: "--font-caption-open-sans",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "112.4%" },
    { prop: "descent-override", value: "31.79%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionOswald = localFont({
  src: "../../../packages/caption-fonts/fonts/Oswald-Bold.ttf",
  weight: "700",
  style: "normal",
  variable: "--font-caption-oswald",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "132.5%" },
    { prop: "descent-override", value: "37.7%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionPoppins = localFont({
  src: "../../../packages/caption-fonts/fonts/Poppins-ExtraBold.ttf",
  weight: "800",
  style: "normal",
  variable: "--font-caption-poppins",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "113.5%" },
    { prop: "descent-override", value: "62.7%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionRighteous = localFont({
  src: "../../../packages/caption-fonts/fonts/Righteous-Regular.ttf",
  weight: "400",
  style: "normal",
  variable: "--font-caption-righteous",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "98.49%" },
    { prop: "descent-override", value: "25.68%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionRoboto = localFont({
  src: "../../../packages/caption-fonts/fonts/Roboto-Bold.ttf",
  weight: "700",
  style: "normal",
  variable: "--font-caption-roboto",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "95.02%" },
    { prop: "descent-override", value: "25%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionTitanOne = localFont({
  src: "../../../packages/caption-fonts/fonts/TitanOne-Regular.ttf",
  weight: "400",
  style: "normal",
  variable: "--font-caption-titan-one",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "97%" },
    { prop: "descent-override", value: "17.5%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionUnbounded = localFont({
  src: "../../../packages/caption-fonts/fonts/Unbounded-ExtraBold.ttf",
  weight: "800",
  style: "normal",
  variable: "--font-caption-unbounded",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "126.2%" },
    { prop: "descent-override", value: "28.6%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

/** CSS variable classes for <html>; each variable holds one caption face's family. */
export const captionFontVariables = [
  captionAnton.variable,
  captionArchivoBlack.variable,
  captionBebasNeue.variable,
  captionBricolageGrotesque.variable,
  captionChakraPetch.variable,
  captionCourierPrime.variable,
  captionDelaGothicOne.variable,
  captionInstrumentSerif.variable,
  captionInter.variable,
  captionInterSemiBold.variable,
  captionLilitaOne.variable,
  captionLuckiestGuy.variable,
  captionMontserrat.variable,
  captionOpenSans.variable,
  captionOswald.variable,
  captionPoppins.variable,
  captionRighteous.variable,
  captionRoboto.variable,
  captionTitanOne.variable,
  captionUnbounded.variable,
].join(" ");
