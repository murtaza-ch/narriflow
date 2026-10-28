/**
 * Runtime route-registration comparison: composes the real app from the real
 * domain modules (no database, Redis or provider is contacted) and compares
 * every mounted endpoint with the domains' admission declarations in both
 * directions. Exits non-zero on any undeclared route, phantom declaration,
 * route without its guard, duplicate registration or shadowed literal path.
 */
import { checkRouteInventory } from "../src/route-inventory";
import { createInventoryApp } from "../src/test-app";

const report = checkRouteInventory(createInventoryApp());
for (const problem of report.problems) {
  console.warn(JSON.stringify({ level: "error", message: "route_inventory_problem", ...problem }));
}
console.warn(
  JSON.stringify({
    level: report.problems.length > 0 ? "error" : "info",
    message: "route_inventory_checked",
    routes: report.checkedRoutes,
    protocolRoutes: report.protocolRoutes,
    problems: report.problems.length,
  }),
);
process.exit(report.problems.length > 0 ? 1 : 0);
