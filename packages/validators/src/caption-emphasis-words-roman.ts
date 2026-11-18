/**
 * Roman Urdu and Hindi word lists for the caption emphasis scorer. They apply
 * token by token to Latin-script tokens when the transcript language is `ur`
 * or `hi`, together with the English lists (code-switched speech mixes both).
 *
 * `do` (two, also "give"), `ek` (one, also "a") and `saath` (sixty, also "with")
 * are left out of the number words.
 */
export const CAPTION_EMPHASIS_ROMAN = {
  minor:
    "ka ki ke ko se mein main me mai par pe tak ne wala wali wale waala waali waale liye lie " +
    "sath saath baad pehle upar neeche andar bahar taraf bare baare jaisa jaisi jaise tarah bina " +
    "hum tum aap woh wo voh yeh ye yahi wohi us is un in ise unhe inhe unhon inhon mujhe humein hamein " +
    "tumhe tumhein mujh tujhe mera meri mere hamara hamari hamare tumhara tumhari tumhare " +
    "aapka aapki aapke apna apni apne jo jis jin kaun kya kis kisi kuch koi aisa aisi aise waisa " +
    "yahan wahan jahan kahan idhar udhar " +
    "hai hain tha thi the ho hoon hun hua hui hue hoga hogi honge ga gi ge raha rahi rahe " +
    "sakta sakti sakte chuka chuki chuke jata jati jate jaata jaati jaate hota hoti hote " +
    "kar karna karte karta karti karke kiya diya di diye liya li le gaya gayi gaye gai ja jaye " +
    "aur ya lekin magar ki agar to jab tab kyunki kyonki balki phir bhi hi taake warna jabke ab ek",
  filler:
    "yaar yar bhai bhaiya matlab toh bas acha achha accha haan han ji waise vaise yani yaani " +
    "arey arre dekho dekhiye",
  negation: "nahi nahin nai nahee na mat",
  number:
    "teen char chaar panch paanch chhe saat aath nau das bees pachees tees chalees pachas sattar " +
    "assi nabbe sau hazaar hazar lakh crore arab aadha aadhi dugna",
  power: "",
  unit:
    "percent fisad feesad hazaar hazar lakh crore arab saal din ghante ghanta minute minat second " +
    "rupay rupaye rupee rupees dollar dollars baar guna mahine hafte",
} as const;
