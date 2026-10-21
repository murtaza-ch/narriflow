import { Newsreader } from "next/font/google";

/** Editorial serif for headlines; body and UI text use the app's Geist. */
export const landingSerif = Newsreader({
  subsets: ["latin"],
  variable: "--lx-font-serif",
  axes: ["opsz"],
  style: ["normal", "italic"],
  display: "swap",
});
