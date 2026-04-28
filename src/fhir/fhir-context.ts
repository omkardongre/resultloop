/**
 * FHIR context type provided by Prompt Opinion via request headers.
 */
export type FhirContext = {
  /** The base URL of the workspace FHIR server */
  url: string;
  /** OAuth2 bearer token for FHIR API calls */
  token?: string;
};
