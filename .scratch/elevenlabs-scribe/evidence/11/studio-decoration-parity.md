# Studio pill/plate vs export ink (findings 8 and 10)

Harness: temporary /dev-preview route (deleted), Anton 56 px, scale 1, agent-browser screenshot `studio-after.png`.
Heights are pill/plate `height` in em; export numbers come from `shapeCaptionRun` ink fed through the worker's `decorationSpan` policy
(max(capHeight, inkTop) + pad above, max(padBottom, inkBottom + 0.06) below; Anton cap 0.8594).

| Case | Studio before | Studio after | Export |
| --- | --- | --- | --- |
| Latin "Hello" pill | 1.2794 | 1.2794 | 1.2794 |
| Latin plate | 1.5594 | 1.5594 | 1.5594 |
| Urdu مُحَبَّتُوں pill | 1.2794 (top 0.851 em) | 2.23 | 2.2300 |
| Urdu plate (line ink) | 1.5594 | 2.39 | 2.3900 |
| Devanagari क्षत्रिय pill | 1.2794 | 1.316 | 1.3160 |
| Devanagari plate | 1.5594 | 1.596 | 1.5960 |
| ज्ञान pill (ink inside pad) | 1.2794 | 1.2794 | 1.2794 |

Baselines are read from a zero-size anchor in the DOM, so a fallback face taller than the requested one (Nastaliq baseline 1.91 em vs Anton 1.40 em)
moves the decoration with the text.
