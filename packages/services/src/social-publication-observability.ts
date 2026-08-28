export type SocialPublicationMetricAttributes = Record<
  string,
  string | number | boolean | undefined
>;

export interface SocialPublicationMetrics {
  observe(
    name: string,
    value: number,
    attributes?: SocialPublicationMetricAttributes,
  ): void;
}

export const structuredSocialPublicationMetrics: SocialPublicationMetrics = {
  observe(name, value, attributes = {}) {
    console.warn(
      JSON.stringify({
        level: "info",
        message: "social_publication_metric",
        metric: name,
        value,
        ...attributes,
      }),
    );
  },
};
