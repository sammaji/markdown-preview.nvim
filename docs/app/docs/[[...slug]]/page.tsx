import { redirect } from 'next/navigation';
import { source } from '@/lib/source';

// the pages used to live under /docs; send old links to their new place
export default async function Page(props: PageProps<'/docs/[[...slug]]'>) {
  const { slug = [] } = await props.params;
  redirect(`/${slug.join('/')}`);
}

export function generateStaticParams() {
  return source.generateParams();
}

// paths not generated at build time are a 404, not an error
export const dynamicParams = false;
