import { Request } from "express";
import axios, { AxiosRequestConfig, isAxiosError } from "axios";
import { FhirContext } from "./fhir-context.js";
import { FhirUtilities } from "./fhir-utilities.js";
import { fhirR4 } from "@smile-cdr/fhirts";
import { logger } from "../util/logger.js";

/**
 * FHIR R4 client for making authenticated requests to the workspace FHIR server.
 *
 * Handles:
 * - Bearer token injection from FHIR context
 * - Base URL resolution
 * - 404 → null conversion
 * - Structured error logging
 */
class FhirClient {
  /**
   * Read a single FHIR resource by relative path (e.g., "Patient/123").
   */
  async read<T>(req: Request, path: string): Promise<T | null> {
    const fhirContext = FhirUtilities.getFhirContextOrThrow(req);
    return await this.callAxios<T>(
      {
        method: "get",
        url: this.buildUrl(fhirContext, path),
      },
      req,
    );
  }

  /**
   * Search FHIR resources with query parameters.
   * Returns a FHIR Bundle containing matching resources.
   */
  async search(
    req: Request,
    resourceType: string,
    searchParams: string[],
  ): Promise<fhirR4.Bundle> {
    const fhirContext = FhirUtilities.getFhirContextOrThrow(req);
    const url = this.buildUrl(
      fhirContext,
      `${resourceType}?${searchParams.join("&")}`,
    );

    logger.debug({ resourceType, searchParams, url }, "FHIR search request");

    const result = await this.callAxios<fhirR4.Bundle>(
      { method: "get", url },
      req,
    );

    return result ?? { resourceType: "Bundle", type: "searchset", entry: [] };
  }

  /**
   * Create (POST) a new FHIR resource. Returns the created resource with server-assigned id + meta.
   */
  async create<T extends Record<string, unknown>>(
    req: Request,
    resource: T,
  ): Promise<T> {
    const fhirContext = FhirUtilities.getFhirContextOrThrow(req);
    const resourceType = resource["resourceType"] as string;
    if (!resourceType)
      throw new Error("resource must have a resourceType field");

    const result = await this.callAxios<T>(
      {
        method: "post",
        url: this.buildUrl(fhirContext, resourceType),
        data: resource,
        headers: { "Content-Type": "application/fhir+json" },
      },
      req,
    );

    if (!result)
      throw new Error(`FHIR create returned null for ${resourceType}`);
    return result;
  }

  private async callAxios<T>(
    axiosConfig: AxiosRequestConfig,
    req: Request,
  ): Promise<T | null> {
    const fhirContext = FhirUtilities.getFhirContextOrThrow(req);

    if (fhirContext.token) {
      axiosConfig.headers = {
        ...axiosConfig.headers,
        Authorization: `Bearer ${fhirContext.token}`,
      };
    }

    try {
      const response = await axios(axiosConfig);
      return response.data as T;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        logger.debug({ url: axiosConfig.url }, "FHIR resource not found (404)");
        return null;
      }

      logger.error(
        {
          url: axiosConfig.url,
          status: isAxiosError(error) ? error.response?.status : undefined,
          message: error instanceof Error ? error.message : "Unknown error",
        },
        "FHIR API call failed",
      );

      throw error;
    }
  }

  private buildUrl(fhirContext: FhirContext, path: string): string {
    const cleanPath = path.startsWith("/") ? path.substring(1) : path;
    return `${fhirContext.url}/${cleanPath}`;
  }
}

export const fhirClient = new FhirClient();
