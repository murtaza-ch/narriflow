import { autopilotService } from "@narriflow/services";
import { autopilotRuleInputSchema, autopilotRuleUpdateSchema } from "@narriflow/validators";
import { Hono } from "hono";
import { admit, getActor } from "../../http/admission";
import type { ApiEnv } from "../../http/env";
import { validate } from "../../http/route";
import { automationAdmission as access } from "./admission";

/** Services the automation routes call. `runtime.ts` supplies the production instance. */
export interface AutomationRouteDeps {
  autopilotService: typeof autopilotService;
}

/** Autopilot rules. Zoom and standing grants are added by the automation owner. */
export function createAutomationRoutes(deps: AutomationRouteDeps) {
  const { autopilotService } = deps;

  return new Hono<ApiEnv>()
    .get("/autopilot/rules", admit(access["GET /autopilot/rules"]), async (c) => {
      const rules = await autopilotService.listRules(getActor(c));
      return c.json({ rules }, 200);
    })

    .post(
      "/autopilot/rules",
      admit(access["POST /autopilot/rules"]),
      validate("json", autopilotRuleInputSchema),
      async (c) => {
        const rule = await autopilotService.createRule(getActor(c), c.req.valid("json"));
        return c.json(rule, 201);
      },
    )

    .patch(
      "/autopilot/rules/:ruleId",
      admit(access["PATCH /autopilot/rules/:ruleId"]),
      validate("json", autopilotRuleUpdateSchema),
      async (c) => {
        const rule = await autopilotService.updateRule(
          getActor(c),
          c.req.param("ruleId"),
          c.req.valid("json"),
        );
        return c.json(rule, 200);
      },
    )

    .delete(
      "/autopilot/rules/:ruleId",
      admit(access["DELETE /autopilot/rules/:ruleId"]),
      async (c) => {
        await autopilotService.deleteRule(getActor(c), c.req.param("ruleId"));
        return c.json({ ok: true }, 200);
      },
    )

    .post(
      "/autopilot/rules/:ruleId/take-over",
      admit(access["POST /autopilot/rules/:ruleId/take-over"]),
      async (c) => {
        const rule = await autopilotService.takeOver(getActor(c), c.req.param("ruleId"));
        return c.json(rule, 200);
      },
    )

    .post(
      "/autopilot/rules/:ruleId/run-now",
      admit(access["POST /autopilot/rules/:ruleId/run-now"]),
      async (c) => {
        const rule = await autopilotService.triggerRuleNow(getActor(c), c.req.param("ruleId"));
        return c.json(rule, 200);
      },
    );
}

export type AutomationRoutes = ReturnType<typeof createAutomationRoutes>;
