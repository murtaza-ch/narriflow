-- BrandTemplate table

CREATE TABLE "BrandTemplate" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID,
  "name" TEXT NOT NULL,
  "isBuiltIn" BOOLEAN NOT NULL DEFAULT false,
  "builtInKey" TEXT,
  "captionPreset" JSONB NOT NULL,
  "logoStorageKey" TEXT,
  "logoPosition" TEXT NOT NULL DEFAULT 'bot-right',
  "logoOpacity" INTEGER NOT NULL DEFAULT 80,
  "logoScalePct" INTEGER NOT NULL DEFAULT 15,
  "primaryColor" TEXT NOT NULL DEFAULT '#FFFFFF',
  "secondaryColor" TEXT NOT NULL DEFAULT '#00FF88',
  "accentColor" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),

  CONSTRAINT "BrandTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BrandTemplate_builtInKey_key" ON "BrandTemplate"("builtInKey");
CREATE INDEX "BrandTemplate_userId_deletedAt_createdAt_idx" ON "BrandTemplate"("userId", "deletedAt", "createdAt");
CREATE INDEX "BrandTemplate_isBuiltIn_idx" ON "BrandTemplate"("isBuiltIn");

ALTER TABLE "BrandTemplate"
  ADD CONSTRAINT "BrandTemplate_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- User: defaultBrandTemplateId

ALTER TABLE "User"
  ADD COLUMN "defaultBrandTemplateId" UUID;

ALTER TABLE "User"
  ADD CONSTRAINT "User_defaultBrandTemplateId_fkey"
    FOREIGN KEY ("defaultBrandTemplateId") REFERENCES "BrandTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Project: brandTemplateId + brandSnapshot

ALTER TABLE "Project"
  ADD COLUMN "brandTemplateId" UUID,
  ADD COLUMN "brandSnapshot" JSONB;

CREATE INDEX "Project_brandTemplateId_idx" ON "Project"("brandTemplateId");

ALTER TABLE "Project"
  ADD CONSTRAINT "Project_brandTemplateId_fkey"
    FOREIGN KEY ("brandTemplateId") REFERENCES "BrandTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed 12 built-in brand templates (from caption-presets.ts)

INSERT INTO "BrandTemplate" ("id", "userId", "name", "isBuiltIn", "builtInKey", "captionPreset", "primaryColor", "secondaryColor")
VALUES
  (
    gen_random_uuid(), NULL, 'Minimal', true, 'minimal',
    '{"fontName":"Montserrat","primaryColor":"#C8C8C8","outlineColor":"#000000","outlineWidth":0,"shadow":0,"bold":false,"position":"bottom","highlightColor":"#FFFFFF","animation":"word-by-word","fontSize":32,"textTransform":"none","letterSpacing":0.01}'::jsonb,
    '#C8C8C8', '#FFFFFF'
  ),
  (
    gen_random_uuid(), NULL, 'Karaoke', true, 'karaoke',
    '{"fontName":"Bebas Neue","primaryColor":"#FFFFFF","outlineColor":"#000000","outlineWidth":3,"shadow":1,"bold":true,"position":"bottom","highlightColor":"#00FF88","animation":"karaoke","fontSize":42,"textTransform":"uppercase","letterSpacing":0.04}'::jsonb,
    '#FFFFFF', '#00FF88'
  ),
  (
    gen_random_uuid(), NULL, 'Highlighter', true, 'highlighter',
    '{"fontName":"Roboto","primaryColor":"#E8E8E8","outlineColor":"#1A1A2E","outlineWidth":2,"shadow":1,"bold":true,"position":"bottom","highlightColor":"#FFFFFF","animation":"word-by-word","fontSize":36,"textTransform":"capitalize","letterSpacing":0.02,"highlightBoxColor":"#FF3CAC","highlightBoxOpacity":0.95}'::jsonb,
    '#E8E8E8', '#FF3CAC'
  ),
  (
    gen_random_uuid(), NULL, 'Neon Dreams', true, 'neon-dreams',
    '{"fontName":"Bebas Neue","primaryColor":"#00F5FF","outlineColor":"#002B33","outlineWidth":1,"shadow":0,"bold":true,"position":"center","highlightColor":"#FF00FF","animation":"blur-in","fontSize":44,"textTransform":"uppercase","letterSpacing":0.08,"glowColor":"#00F5FF","glowIntensity":16}'::jsonb,
    '#00F5FF', '#FF00FF'
  ),
  (
    gen_random_uuid(), NULL, 'Fire', true, 'fire',
    '{"fontName":"Impact","primaryColor":"#FFE100","outlineColor":"#000000","outlineWidth":3,"shadow":1,"bold":true,"position":"bottom","highlightColor":"#FF1744","animation":"bounce","fontSize":46,"textTransform":"uppercase","letterSpacing":0.04,"glowColor":"#FF6D00","glowIntensity":8}'::jsonb,
    '#FFE100', '#FF1744'
  ),
  (
    gen_random_uuid(), NULL, 'Pastel Cloud', true, 'pastel-cloud',
    '{"fontName":"Montserrat","primaryColor":"#FFB8D1","outlineColor":"#4A2040","outlineWidth":1,"shadow":0,"bold":false,"position":"bottom","highlightColor":"#C490FF","animation":"soft-landing","fontSize":34,"textTransform":"lowercase","letterSpacing":0.03,"glowColor":"#FFB8D1","glowIntensity":6}'::jsonb,
    '#FFB8D1', '#C490FF'
  ),
  (
    gen_random_uuid(), NULL, 'Street', true, 'street',
    '{"fontName":"Oswald","primaryColor":"#AAFF00","outlineColor":"#000000","outlineWidth":4,"shadow":1,"bold":true,"position":"bottom","highlightColor":"#FFFFFF","animation":"seamless-bounce","fontSize":40,"textTransform":"uppercase","letterSpacing":0.06}'::jsonb,
    '#AAFF00', '#FFFFFF'
  ),
  (
    gen_random_uuid(), NULL, 'Frosted Glass', true, 'frosted-glass',
    '{"fontName":"Open Sans","primaryColor":"#FFFFFF","outlineColor":"#000000","outlineWidth":0,"shadow":0,"bold":true,"position":"bottom","highlightColor":"#4ADE80","animation":"word-by-word","fontSize":32,"textTransform":"none","letterSpacing":0.02,"backgroundColor":"#0F172A","backgroundOpacity":0.78}'::jsonb,
    '#FFFFFF', '#4ADE80'
  ),
  (
    gen_random_uuid(), NULL, 'Sunset', true, 'sunset',
    '{"fontName":"Bebas Neue","primaryColor":"#FF6B6B","outlineColor":"#2D1B14","outlineWidth":2,"shadow":1,"bold":true,"position":"bottom","highlightColor":"#FFD93D","animation":"grow","fontSize":42,"textTransform":"uppercase","letterSpacing":0.05}'::jsonb,
    '#FF6B6B', '#FFD93D'
  ),
  (
    gen_random_uuid(), NULL, 'Matrix', true, 'matrix',
    '{"fontName":"Roboto","primaryColor":"#00FF41","outlineColor":"#003300","outlineWidth":1,"shadow":0,"bold":true,"position":"center","highlightColor":"#7FFF00","animation":"glitch","fontSize":36,"textTransform":"uppercase","letterSpacing":0.1,"glowColor":"#00FF41","glowIntensity":10}'::jsonb,
    '#00FF41', '#7FFF00'
  ),
  (
    gen_random_uuid(), NULL, 'Luxe Gold', true, 'luxe-gold',
    '{"fontName":"Montserrat","primaryColor":"#D4AF37","outlineColor":"#1A1400","outlineWidth":1,"shadow":1,"bold":true,"position":"bottom","highlightColor":"#FFF1CC","animation":"breathe","fontSize":36,"textTransform":"uppercase","letterSpacing":0.12,"glowColor":"#D4AF37","glowIntensity":5}'::jsonb,
    '#D4AF37', '#FFF1CC'
  ),
  (
    gen_random_uuid(), NULL, 'Electric', true, 'electric',
    '{"fontName":"Impact","primaryColor":"#FFFFFF","outlineColor":"#000000","outlineWidth":4,"shadow":1,"bold":true,"position":"bottom","highlightColor":"#FFFFFF","animation":"word-by-word","fontSize":44,"textTransform":"uppercase","letterSpacing":0.04,"highlightBoxColor":"#3B82F6","highlightBoxOpacity":1.0}'::jsonb,
    '#FFFFFF', '#3B82F6'
  );
