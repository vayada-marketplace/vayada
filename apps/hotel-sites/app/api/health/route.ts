// The load balancer's health check: it calls the task by IP, so it can't name a hotel's host.
export function GET() {
  return Response.json({ status: "ok" });
}
