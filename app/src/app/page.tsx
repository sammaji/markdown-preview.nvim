import { Preview } from "@/components/preview";

// Served for /page/<bufnr>; the buffer number is read from the URL.
export default function Page() {
  return <Preview />;
}
