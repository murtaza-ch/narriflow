CREATE INDEX "GenerationFinishing_recovery_cursor" ON "GenerationFinishing" ("deploymentEpoch","createdAt",id)
  WHERE state IN ('due','running','exporting');
CREATE INDEX "GenerationFinishing_restore_cursor" ON "GenerationFinishing" ("createdAt",id)
  WHERE state IN ('waiting','due','running','exporting');
