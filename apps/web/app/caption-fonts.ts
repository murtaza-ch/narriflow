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

const captionCaprasimo = localFont({
  src: "../../../packages/caption-fonts/fonts/Caprasimo-Regular.ttf",
  weight: "400",
  style: "normal",
  variable: "--font-caption-caprasimo",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "91.8%" },
    { prop: "descent-override", value: "22.9%" },
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

const captionDmSerifDisplay = localFont({
  src: "../../../packages/caption-fonts/fonts/DMSerifDisplay-Regular.ttf",
  weight: "400",
  style: "normal",
  variable: "--font-caption-dm-serif-display",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "103.6%" },
    { prop: "descent-override", value: "33.5%" },
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

const captionInterRegular = localFont({
  src: "../../../packages/caption-fonts/fonts/Inter-Regular.ttf",
  weight: "400",
  style: "normal",
  variable: "--font-caption-inter-regular",
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

const captionCaveatBrush = localFont({
  src: "../../../packages/caption-fonts/fonts/CaveatBrush-Regular.ttf",
  weight: "400",
  style: "normal",
  variable: "--font-caption-caveat-brush",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "96%" },
    { prop: "descent-override", value: "30%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionInterTightSemiBold = localFont({
  src: "../../../packages/caption-fonts/fonts/InterTight-SemiBold.ttf",
  weight: "600",
  style: "normal",
  variable: "--font-caption-inter-tight-semibold",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "110.5%" },
    { prop: "descent-override", value: "31.93%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionInterTightBold = localFont({
  src: "../../../packages/caption-fonts/fonts/InterTight-Bold.ttf",
  weight: "700",
  style: "normal",
  variable: "--font-caption-inter-tight-bold",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "110.5%" },
    { prop: "descent-override", value: "31.93%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionInterTightExtraBold = localFont({
  src: "../../../packages/caption-fonts/fonts/InterTight-ExtraBold.ttf",
  weight: "800",
  style: "normal",
  variable: "--font-caption-inter-tight-extrabold",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "110.5%" },
    { prop: "descent-override", value: "31.93%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionJetBrainsMonoMedium = localFont({
  src: "../../../packages/caption-fonts/fonts/JetBrainsMono-Medium.ttf",
  weight: "500",
  style: "normal",
  variable: "--font-caption-jetbrains-mono-medium",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "102%" },
    { prop: "descent-override", value: "30%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionJetBrainsMonoBold = localFont({
  src: "../../../packages/caption-fonts/fonts/JetBrainsMono-Bold.ttf",
  weight: "700",
  style: "normal",
  variable: "--font-caption-jetbrains-mono-bold",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "102%" },
    { prop: "descent-override", value: "30%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionPermanentMarker = localFont({
  src: "../../../packages/caption-fonts/fonts/PermanentMarker-Regular.ttf",
  weight: "400",
  style: "normal",
  variable: "--font-caption-permanent-marker",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "110.94%" },
    { prop: "descent-override", value: "31.74%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionUnboundedMedium = localFont({
  src: "../../../packages/caption-fonts/fonts/Unbounded-Medium.ttf",
  weight: "500",
  style: "normal",
  variable: "--font-caption-unbounded-medium",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "126.2%" },
    { prop: "descent-override", value: "28.6%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionUnboundedBlack = localFont({
  src: "../../../packages/caption-fonts/fonts/Unbounded-Black.ttf",
  weight: "900",
  style: "normal",
  variable: "--font-caption-unbounded-black",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "126.2%" },
    { prop: "descent-override", value: "28.6%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionInterTightMedium = localFont({
  src: "../../../packages/caption-fonts/fonts/InterTight-Medium.ttf",
  weight: "500",
  style: "normal",
  variable: "--font-caption-inter-tight-medium",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "110.5%" },
    { prop: "descent-override", value: "31.93%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionInstrumentSerifRegular = localFont({
  src: "../../../packages/caption-fonts/fonts/InstrumentSerif-Regular.ttf",
  weight: "400",
  style: "normal",
  variable: "--font-caption-instrument-serif-regular",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "99%" },
    { prop: "descent-override", value: "31%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionArchivoExpandedExtraBold = localFont({
  src: "../../../packages/caption-fonts/fonts/Archivo-ExpandedExtraBold.ttf",
  weight: "800",
  style: "normal",
  variable: "--font-caption-archivo-expanded-extrabold",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "110%" },
    { prop: "descent-override", value: "41%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionArchivoExpandedExtraBoldItalic = localFont({
  src: "../../../packages/caption-fonts/fonts/Archivo-ExpandedExtraBoldItalic.ttf",
  weight: "800",
  style: "italic",
  variable: "--font-caption-archivo-expanded-extrabold-italic",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "110%" },
    { prop: "descent-override", value: "41%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionArchivoExpandedBlack = localFont({
  src: "../../../packages/caption-fonts/fonts/Archivo-ExpandedBlack.ttf",
  weight: "900",
  style: "normal",
  variable: "--font-caption-archivo-expanded-black",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "110%" },
    { prop: "descent-override", value: "41%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionArchivoExpandedBlackItalic = localFont({
  src: "../../../packages/caption-fonts/fonts/Archivo-ExpandedBlackItalic.ttf",
  weight: "900",
  style: "italic",
  variable: "--font-caption-archivo-expanded-black-italic",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "110%" },
    { prop: "descent-override", value: "41%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionArchivoExtraBoldItalic = localFont({
  src: "../../../packages/caption-fonts/fonts/Archivo-ExtraBoldItalic.ttf",
  weight: "800",
  style: "italic",
  variable: "--font-caption-archivo-extrabold-italic",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "110%" },
    { prop: "descent-override", value: "41%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionRubikBlack = localFont({
  src: "../../../packages/caption-fonts/fonts/Rubik-Black.ttf",
  weight: "900",
  style: "normal",
  variable: "--font-caption-rubik-black",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "106.6%" },
    { prop: "descent-override", value: "46.6%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionYesteryear = localFont({
  src: "../../../packages/caption-fonts/fonts/Yesteryear-Regular.ttf",
  weight: "400",
  style: "normal",
  variable: "--font-caption-yesteryear",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "97.71%" },
    { prop: "descent-override", value: "49.02%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionBigShouldersDisplayBlack = localFont({
  src: "../../../packages/caption-fonts/fonts/BigShouldersDisplay-Black.ttf",
  weight: "900",
  style: "normal",
  variable: "--font-caption-big-shoulders-display-black",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "130.7%" },
    { prop: "descent-override", value: "36.5%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionShrikhand = localFont({
  src: "../../../packages/caption-fonts/fonts/Shrikhand-Regular.ttf",
  weight: "400",
  style: "normal",
  variable: "--font-caption-shrikhand",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "102.6%" },
    { prop: "descent-override", value: "43.2%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionBarlowCondensedBlackItalic = localFont({
  src: "../../../packages/caption-fonts/fonts/BarlowCondensed-BlackItalic.ttf",
  weight: "900",
  style: "italic",
  variable: "--font-caption-barlow-condensed-black-italic",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "107.5%" },
    { prop: "descent-override", value: "27.4%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionLexendExaLight = localFont({
  src: "../../../packages/caption-fonts/fonts/LexendExa-Light.ttf",
  weight: "300",
  style: "normal",
  variable: "--font-caption-lexend-exa-light",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "120%" },
    { prop: "descent-override", value: "39%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionChango = localFont({
  src: "../../../packages/caption-fonts/fonts/Chango-Regular.ttf",
  weight: "400",
  style: "normal",
  variable: "--font-caption-chango",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "99.5%" },
    { prop: "descent-override", value: "21.6%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionAlfaSlabOne = localFont({
  src: "../../../packages/caption-fonts/fonts/AlfaSlabOne-Regular.ttf",
  weight: "400",
  style: "normal",
  variable: "--font-caption-alfa-slab-one",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "123.8%" },
    { prop: "descent-override", value: "32.7%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

const captionAbrilFatface = localFont({
  src: "../../../packages/caption-fonts/fonts/AbrilFatface-Regular.ttf",
  weight: "400",
  style: "normal",
  variable: "--font-caption-abril-fatface",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "ascent-override", value: "105.8%" },
    { prop: "descent-override", value: "29.1%" },
    { prop: "line-gap-override", value: "0%" },
  ],
});

/** CSS variable classes for <html>; each variable holds one caption face's family. */
export const captionFontVariables = [
  captionAnton.variable,
  captionArchivoBlack.variable,
  captionBebasNeue.variable,
  captionBricolageGrotesque.variable,
  captionCaprasimo.variable,
  captionChakraPetch.variable,
  captionCourierPrime.variable,
  captionDelaGothicOne.variable,
  captionDmSerifDisplay.variable,
  captionInstrumentSerif.variable,
  captionInter.variable,
  captionInterRegular.variable,
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
  captionCaveatBrush.variable,
  captionInterTightSemiBold.variable,
  captionInterTightBold.variable,
  captionInterTightExtraBold.variable,
  captionJetBrainsMonoMedium.variable,
  captionJetBrainsMonoBold.variable,
  captionPermanentMarker.variable,
  captionUnboundedMedium.variable,
  captionUnboundedBlack.variable,
  captionInterTightMedium.variable,
  captionInstrumentSerifRegular.variable,
  captionArchivoExpandedExtraBold.variable,
  captionArchivoExpandedExtraBoldItalic.variable,
  captionArchivoExpandedBlack.variable,
  captionArchivoExpandedBlackItalic.variable,
  captionArchivoExtraBoldItalic.variable,
  captionRubikBlack.variable,
  captionYesteryear.variable,
  captionBigShouldersDisplayBlack.variable,
  captionShrikhand.variable,
  captionBarlowCondensedBlackItalic.variable,
  captionLexendExaLight.variable,
  captionChango.variable,
  captionAlfaSlabOne.variable,
  captionAbrilFatface.variable,
].join(" ");
