export function replaceKeepingDetails(body: HTMLElement, html: string) {
  const open = [...body.querySelectorAll("details")].map(
    (details) => details.open,
  );
  body.innerHTML = html;
  body.querySelectorAll("details").forEach((details, index) => {
    if (index < open.length) details.open = open[index];
  });
}
