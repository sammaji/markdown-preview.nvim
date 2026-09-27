import { Preview } from "@/components/preview";

// Served for /page/<bufnr> and /files/<path>; the page reads which from the URL.
export default function Page() {
  return <Preview />;
}
