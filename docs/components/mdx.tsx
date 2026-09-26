import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import type { ComponentProps } from 'react';

// next/image needs a size, which source.config.ts no longer fetches for remote
// images; those are shown as they are
function Img(props: ComponentProps<typeof defaultMdxComponents.img>) {
  if (props.width !== undefined || typeof props.src !== 'string') return <defaultMdxComponents.img {...props} />;
  const { src, alt, title, className } = props;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} title={title} className={className} />;
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    img: Img,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
