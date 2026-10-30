| Lang | Metric | AAI set lang (model) | Scribe set lang | AAI auto (detected) | Scribe auto (detected) |
|---|---|---|---|---|---|
| en_us | wer | 8.4% (universal-3-5-pro) | 5.3% | 7.6% (en) | 4.8% (eng) |
| es_419 | wer | 2.4% (universal-3-5-pro) | 2.8% | 2.4% (es) | 2.8% (spa) |
| ar_eg | wer | 22.1% · 1 dropped (universal-3-5-pro) | 3.6% | 22.3% · 1 dropped (ar) | 4.4% (ara) |
| hi_in | wer | 18.7% (universal-3-5-pro) | 9.3% · script 90.1% | 18.9% (hi) | 11.4% · script 83.1% (hin) |
| ur_pk | wer | 22.5% (universal-2) | 11.7% | 89.6% · 1 dropped · script 26% (hi) | 12% (urd) |
| pa_in | wer | 99.5% · 1 dropped · script 0% (universal-2) | 17% · script 85.2% | 99.5% · 1 dropped · script 0% (pa) | 16.3% · script 85.5% (pan) |
| ps_af | wer | 90.3% · script 77.6% (universal-2) | 42.7% | 90.3% · script 77.6% (ps) | 43.1% (pus) |
| sd_in | wer | 96.8% · 3 dropped · script 39.3% (universal-2) | 19.6% | 89.1% · 2 dropped (ur) | 18.9% (snd) |
| bn_in | wer | 100% · script 0% (universal-2) | 13.6% | 100% · script 0% (bn) | 13.9% (ben) |
| ta_in | wer | 61.8% · 2 dropped (universal-2) | 41.3% · script 93.4% | 61.8% · 2 dropped (ta) | 87.5% · 18 dropped (tam) |
| mr_in | wer | 83.2% (universal-2) | 20% | 83% (mr) | 19.3% (mar) |
| fa_ir | wer | 37% (universal-2) | 10.7% | 38.7% (fa) | 10.7% (fas) |
| tr_tr | wer | 11.7% (universal-3-5-pro) | 4.9% | 10.7% (tr) | 4.9% (tur) |
| id_id | wer | 5.2% (universal-2) | 0.8% | 5.2% (id) | 0.8% (ind) |
| cmn_hans_cn | cer | 8.7% (universal-3-5-pro) | 6.7% | 8.9% (zh) | 6.7% (zho) |
| ja_jp | cer | 5.1% (universal-3-5-pro) | 5.2% | 5.5% (ja) | 4.9% (jpn) |

Timestamp-aligned error (words placed in the right sentence), zero-length words:
en_us AAI 8.9 zero 0 | EL 5.3 zero 0
es_419 AAI 2.4 zero 0 | EL 2.8 zero 0
ar_eg AAI 22.3 zero 0 | EL 3.6 zero 0
hi_in AAI 19.5 zero 0 | EL 9.3 zero 0
ur_pk AAI 23.4 zero 0 | EL 14.4 zero 4
pa_in AAI 99.8 zero 0 | EL 17.7 zero 3
ps_af AAI 90.3 zero 0 | EL 42.7 zero 0
sd_in AAI 100.5 zero 0 | EL 19.6 zero 7
bn_in AAI 107.1 zero 0 | EL 13.6 zero 0
ta_in AAI 61.8 zero 0 | EL 41.3 zero 0
mr_in AAI 86.9 zero 0 | EL 20 zero 0
fa_ir AAI 38.1 zero 0 | EL 11.1 zero 0
tr_tr AAI 11.7 zero 0 | EL 4.9 zero 0
id_id AAI 5.2 zero 0 | EL 0.8 zero 0
cmn_hans_cn AAI 9 zero 7 | EL 6.7 zero 27
ja_jp AAI 5.9 zero 19 | EL 5.2 zero 44

Notes: FLEURS test split, 20 distinct sentences per language joined with 0.4s gaps (~3-6 min per file). Normalization: NFKC, lowercase, punctuation removed, Arabic diacritics/yeh/kaf/alef unified, Devanagari nukta/chandrabindu unified. Same normalization for both providers. Scribe Hindi WER is inflated by English names written in Latin (FLEURS refs use Devanagari). Scribe ta_in auto returned 66 words for 288s (language detected correctly). AAI U2 writes pa/bn in Devanagari, mr as Hindi-like text.
