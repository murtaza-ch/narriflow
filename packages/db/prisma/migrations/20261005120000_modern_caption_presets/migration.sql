-- Modern caption presets: the caption style schema changed (vendored font
-- faces, shadow styles, motion vocabulary, words per cue), so stored styles in
-- the old shape no longer parse. Per the pre-production policy this rewrites
-- dev data instead of keeping a legacy parser.

-- Clip styles: Karaoke clips keep the (rebuilt) Karaoke preset; every other
-- stored style resets to the default (Bold Pop).
UPDATE "Clip"
SET "captionPreset" = CASE
  WHEN "captionPreset"->>'animation' = 'karaoke' THEN '{"fontName":"Bebas Neue","fontSize":96,"textTransform":"uppercase","letterSpacing":0.04,"primaryColor":"#FFFFFF","highlightColor":"#00FF88","outlineColor":"#000000","outlineWidth":6,"shadow":"soft","shadowColor":"#000000","animation":"karaoke","wordsPerCue":3,"position":"bottom"}'::jsonb
  ELSE NULL
END
WHERE "captionPreset" IS NOT NULL;

-- Built-in brand templates mirror the preset catalog (packages/validators/src/caption-preset.ts).
INSERT INTO "BrandTemplate" ("id", "name", "isBuiltIn", "builtInKey", "captionPreset", "primaryColor", "secondaryColor", "updatedAt")
VALUES
  (gen_random_uuid(), 'Bold Pop', true, 'bold-pop', '{"fontName":"Montserrat","fontSize":84,"textTransform":"uppercase","letterSpacing":-0.01,"primaryColor":"#FFFFFF","highlightColor":"#FFE11A","outlineColor":"#000000","outlineWidth":7,"shadow":"soft","shadowColor":"#000000","animation":"pop","wordsPerCue":3,"position":"bottom"}'::jsonb, '#FFFFFF', '#FFE11A', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Blast', true, 'blast', '{"fontName":"Luckiest Guy","fontSize":88,"textTransform":"uppercase","letterSpacing":0.02,"primaryColor":"#FFFFFF","highlightColor":"#48FF6E","outlineColor":"#000000","outlineWidth":8,"shadow":"hard","shadowColor":"#000000","animation":"bounce","wordsPerCue":3,"position":"bottom"}'::jsonb, '#FFFFFF', '#48FF6E', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Punch', true, 'punch', '{"fontName":"Anton","fontSize":132,"textTransform":"uppercase","letterSpacing":0.01,"primaryColor":"#FFFFFF","highlightColor":"#FFFFFF","outlineColor":"#000000","outlineWidth":7,"shadow":"soft","shadowColor":"#000000","animation":"punch","wordsPerCue":1,"position":"bottom"}'::jsonb, '#FFFFFF', '#FFFFFF', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Spotlight', true, 'spotlight', '{"fontName":"Poppins","fontSize":76,"textTransform":"none","letterSpacing":-0.01,"primaryColor":"#FFFFFF","highlightColor":"#FFFFFF","outlineColor":"#000000","outlineWidth":0,"shadow":"soft","shadowColor":"#000000","highlightBoxColor":"#6C4DFF","highlightBoxOpacity":1,"animation":"pop","wordsPerCue":3,"position":"bottom"}'::jsonb, '#FFFFFF', '#6C4DFF', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Street', true, 'street', '{"fontName":"Oswald","fontSize":88,"textTransform":"uppercase","letterSpacing":0.04,"primaryColor":"#AAFF00","highlightColor":"#FFFFFF","outlineColor":"#000000","outlineWidth":8,"shadow":"soft","shadowColor":"#000000","animation":"bounce","wordsPerCue":3,"position":"bottom"}'::jsonb, '#AAFF00', '#FFFFFF', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Electric', true, 'electric', '{"fontName":"Anton","fontSize":88,"textTransform":"uppercase","letterSpacing":0.04,"primaryColor":"#FFFFFF","highlightColor":"#FFFFFF","outlineColor":"#000000","outlineWidth":7,"shadow":"soft","shadowColor":"#000000","highlightBoxColor":"#3B82F6","highlightBoxOpacity":1,"animation":"pop","wordsPerCue":3,"position":"bottom"}'::jsonb, '#FFFFFF', '#3B82F6', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Rise', true, 'rise', '{"fontName":"Inter","fontSize":78,"textTransform":"none","letterSpacing":-0.02,"primaryColor":"#FFFFFF","highlightColor":"#C6FF3D","outlineColor":"#000000","outlineWidth":0,"shadow":"soft","shadowColor":"#000000","animation":"rise","wordsPerCue":3,"position":"bottom"}'::jsonb, '#FFFFFF', '#C6FF3D', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Focus', true, 'focus', '{"fontName":"Inter SemiBold","fontSize":68,"textTransform":"none","letterSpacing":-0.015,"primaryColor":"#FFFFFF","highlightColor":"#FFFFFF","outlineColor":"#000000","outlineWidth":0,"shadow":"soft","shadowColor":"#000000","animation":"focus","wordsPerCue":4,"position":"bottom"}'::jsonb, '#FFFFFF', '#FFFFFF', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Glass', true, 'glass', '{"fontName":"Inter","fontSize":64,"textTransform":"none","letterSpacing":-0.015,"primaryColor":"#FFFFFF","highlightColor":"#7CE0FF","outlineColor":"#000000","outlineWidth":0,"shadow":"none","shadowColor":"#000000","backgroundColor":"#0B0D12","backgroundOpacity":0.62,"animation":"pop","wordsPerCue":4,"position":"bottom"}'::jsonb, '#FFFFFF', '#7CE0FF', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Sticker', true, 'sticker', '{"fontName":"Poppins","fontSize":68,"textTransform":"none","letterSpacing":-0.01,"primaryColor":"#111111","highlightColor":"#FF2E63","outlineColor":"#000000","outlineWidth":0,"shadow":"none","shadowColor":"#000000","backgroundColor":"#FFFFFF","backgroundOpacity":1,"animation":"pop","wordsPerCue":3,"position":"bottom"}'::jsonb, '#111111', '#FF2E63', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Frosted Glass', true, 'frosted-glass', '{"fontName":"Open Sans","fontSize":64,"textTransform":"none","letterSpacing":0.01,"primaryColor":"#FFFFFF","highlightColor":"#4ADE80","outlineColor":"#000000","outlineWidth":0,"shadow":"none","shadowColor":"#000000","backgroundColor":"#0F172A","backgroundOpacity":0.78,"animation":"pop","wordsPerCue":3,"position":"bottom"}'::jsonb, '#FFFFFF', '#4ADE80', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Highlighter', true, 'highlighter', '{"fontName":"Roboto","fontSize":74,"textTransform":"capitalize","letterSpacing":0.01,"primaryColor":"#F2F2F2","highlightColor":"#FFFFFF","outlineColor":"#1A1A2E","outlineWidth":4,"shadow":"soft","shadowColor":"#000000","highlightBoxColor":"#FF3CAC","highlightBoxOpacity":1,"animation":"pop","wordsPerCue":3,"position":"bottom"}'::jsonb, '#F2F2F2', '#FF3CAC', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Bubblegum', true, 'bubblegum', '{"fontName":"Titan One","fontSize":90,"textTransform":"lowercase","letterSpacing":0.01,"primaryColor":"#FFFFFF","highlightColor":"#FFE45C","outlineColor":"#FF4F9A","outlineWidth":8,"shadow":"hard","shadowColor":"#7A1F4A","animation":"bounce","wordsPerCue":2,"position":"bottom"}'::jsonb, '#FFFFFF', '#FFE45C', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Jelly', true, 'jelly', '{"fontName":"Lilita One","fontSize":96,"textTransform":"uppercase","letterSpacing":0.02,"primaryColor":"#FFFFFF","highlightColor":"#A3FF12","outlineColor":"#7C3AED","outlineWidth":9,"shadow":"hard","shadowColor":"#2E1065","animation":"jelly","wordsPerCue":2,"position":"bottom"}'::jsonb, '#FFFFFF', '#A3FF12', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Candy', true, 'candy', '{"fontName":"Titan One","fontSize":82,"textTransform":"uppercase","letterSpacing":0.02,"primaryColor":"#FF5FA2","highlightColor":"#FFD23F","outlineColor":"#FFFFFF","outlineWidth":7,"outerOutlineColor":"#3B1C5A","outerOutlineWidth":5,"shadow":"soft","shadowColor":"#000000","animation":"pop","wordsPerCue":3,"position":"bottom"}'::jsonb, '#FF5FA2', '#FFD23F', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Retro', true, 'retro', '{"fontName":"Dela Gothic One","fontSize":70,"textTransform":"uppercase","letterSpacing":0.01,"primaryColor":"#FFF3D6","highlightColor":"#59F0D2","outlineColor":"#1A1A1A","outlineWidth":4,"shadow":"hard","shadowColor":"#FF5C39","animation":"pop","wordsPerCue":3,"position":"bottom"}'::jsonb, '#FFF3D6', '#59F0D2', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Afterglow', true, 'afterglow', '{"fontName":"Unbounded","fontSize":70,"textTransform":"lowercase","letterSpacing":-0.02,"primaryColor":"#FFFFFF","highlightColor":"#FFD6F5","outlineColor":"#000000","outlineWidth":0,"shadow":"soft","shadowColor":"#000000","highlightGlowColor":"#FF4FD8","glowIntensity":14,"animation":"fade","wordsPerCue":3,"position":"bottom"}'::jsonb, '#FFFFFF', '#FFD6F5', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Cinema', true, 'cinema', '{"fontName":"Instrument Serif","fontSize":106,"textTransform":"lowercase","letterSpacing":0,"primaryColor":"#F6EFE4","highlightColor":"#F2C46D","outlineColor":"#000000","outlineWidth":0,"shadow":"soft","shadowColor":"#000000","animation":"blur","wordsPerCue":3,"position":"bottom"}'::jsonb, '#F6EFE4', '#F2C46D', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Karaoke', true, 'karaoke', '{"fontName":"Bebas Neue","fontSize":96,"textTransform":"uppercase","letterSpacing":0.04,"primaryColor":"#FFFFFF","highlightColor":"#00FF88","outlineColor":"#000000","outlineWidth":6,"shadow":"soft","shadowColor":"#000000","animation":"karaoke","wordsPerCue":3,"position":"bottom"}'::jsonb, '#FFFFFF', '#00FF88', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Neon', true, 'neon', '{"fontName":"Righteous","fontSize":80,"textTransform":"uppercase","letterSpacing":0.04,"primaryColor":"#FFE9FB","highlightColor":"#E9FDFF","outlineColor":"#000000","outlineWidth":0,"shadow":"none","shadowColor":"#000000","glowColor":"#FF2BD6","highlightGlowColor":"#22E4FF","glowIntensity":16,"animation":"neon","wordsPerCue":3,"position":"bottom"}'::jsonb, '#FFE9FB', '#E9FDFF', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Glitch', true, 'glitch', '{"fontName":"Chakra Petch","fontSize":80,"textTransform":"uppercase","letterSpacing":0.02,"primaryColor":"#FFFFFF","highlightColor":"#FFFFFF","outlineColor":"#000000","outlineWidth":0,"shadow":"soft","shadowColor":"#000000","animation":"glitch","wordsPerCue":3,"position":"bottom"}'::jsonb, '#FFFFFF', '#FFFFFF', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Flip', true, 'flip', '{"fontName":"Bricolage Grotesque","fontSize":84,"textTransform":"none","letterSpacing":-0.02,"primaryColor":"#FFFFFF","highlightColor":"#FF8A3D","outlineColor":"#000000","outlineWidth":0,"shadow":"soft","shadowColor":"#000000","animation":"flip","wordsPerCue":3,"position":"bottom"}'::jsonb, '#FFFFFF', '#FF8A3D', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Typewriter', true, 'typewriter', '{"fontName":"Courier Prime","fontSize":70,"textTransform":"none","letterSpacing":-0.02,"primaryColor":"#F5F1E8","highlightColor":"#FFFFFF","outlineColor":"#000000","outlineWidth":0,"shadow":"soft","shadowColor":"#000000","animation":"typewriter","wordsPerCue":4,"position":"bottom"}'::jsonb, '#F5F1E8', '#FFFFFF', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Block', true, 'block', '{"fontName":"Archivo Black","fontSize":82,"textTransform":"uppercase","letterSpacing":-0.01,"primaryColor":"#FFD84D","highlightColor":"#FFFFFF","outlineColor":"#14161C","outlineWidth":4,"shadow":"extrude","shadowColor":"#14161C","animation":"pop","wordsPerCue":3,"position":"bottom"}'::jsonb, '#FFD84D', '#FFFFFF', CURRENT_TIMESTAMP)
ON CONFLICT ("builtInKey") DO UPDATE SET
  "name" = EXCLUDED."name",
  "captionPreset" = EXCLUDED."captionPreset",
  "primaryColor" = EXCLUDED."primaryColor",
  "secondaryColor" = EXCLUDED."secondaryColor",
  "deletedAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP;

DELETE FROM "BrandTemplate"
WHERE "isBuiltIn" AND "builtInKey" NOT IN ('bold-pop', 'blast', 'punch', 'spotlight', 'street', 'electric', 'rise', 'focus', 'glass', 'sticker', 'frosted-glass', 'highlighter', 'bubblegum', 'jelly', 'candy', 'retro', 'afterglow', 'cinema', 'karaoke', 'neon', 'glitch', 'flip', 'typewriter', 'block');

-- User-made templates carry styles in the old shape; reset them to the default.
UPDATE "BrandTemplate"
SET "captionPreset" = (SELECT "captionPreset" FROM "BrandTemplate" WHERE "builtInKey" = 'bold-pop'),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE NOT "isBuiltIn";

-- Preset ids retired from the catalog fall back to the brand default.
UPDATE "ContentPack"
SET "captionPreset" = 'brand_default'
WHERE "captionPreset" IN ('minimal', 'neon-dreams', 'fire', 'pastel-cloud', 'sunset', 'matrix', 'luxe-gold');

UPDATE "AutopilotRule"
SET "contentPack" = jsonb_set("contentPack", '{captionPreset}', '"brand_default"')
WHERE "contentPack"->>'captionPreset' IN ('minimal', 'neon-dreams', 'fire', 'pastel-cloud', 'sunset', 'matrix', 'luxe-gold');
