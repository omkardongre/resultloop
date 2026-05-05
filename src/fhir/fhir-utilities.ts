import { Request } from "express";
import { FhirContext } from "./fhir-context.js";
import { McpConstants } from "./mcp-constants.js";
import * as jose from "jose";
import { logger } from "../util/logger.js";

/**
 * Utilities for extracting FHIR context from incoming MCP requests.
 *
 * Prompt Opinion propagates FHIR server URL, access token, and patient ID
 * via custom HTTP headers on every tool-call request.
 */
export const FhirUtilities = {
  /**
   * Extract the FHIR context (server URL + token) from request headers.
   * Returns null if the required FHIR server URL header is missing.
   */
  getFhirContext: (req: Request): FhirContext | null => {
    const headers = req.headers;
    const url = headers[McpConstants.FhirServerUrlHeaderName]?.toString();

    if (!url) {
      logger.warn("FHIR context missing: no x-fhir-server-url header");
      return null;
    }

    const token = headers[McpConstants.FhirAccessTokenHeaderName]?.toString();

    logger.debug(
      { fhirUrl: url, hasToken: !!token },
      "FHIR context extracted from headers",
    );

    return { url, token };
  },

  /**
   * Extract the patient ID from the FHIR context.
   *
   * Resolution order:
   * 1. Use the x-patient-id header from Prompt Opinion patient scope
   * 2. Fall back to the patient claim from the FHIR access token JWT
   *
   * This ensures we never let the LLM invent patient IDs.
   */
  getPatientIdFromContext: (req: Request): string | null => {
    const headerPatientId =
      req.headers[McpConstants.PatientIdHeaderName]?.toString() || null;

    if (headerPatientId) {
      logger.debug(
        { patientId: headerPatientId },
        "Patient ID extracted from header",
      );
      return headerPatientId;
    }

    const fhirToken =
      req.headers[McpConstants.FhirAccessTokenHeaderName]?.toString();

    if (fhirToken) {
      try {
        const claims = jose.decodeJwt(fhirToken);
        if (claims["patient"]) {
          const patientId = claims["patient"]?.toString();
          logger.debug({ patientId }, "Patient ID extracted from JWT");
          return patientId ?? null;
        }
      } catch (error) {
        logger.warn({ error }, "Failed to decode FHIR access token JWT");
      }
    }

    return null;
  },

  /**
   * Get FHIR context or throw a descriptive error for the MCP response.
   */
  getFhirContextOrThrow: (req: Request): FhirContext => {
    const ctx = FhirUtilities.getFhirContext(req);
    if (!ctx) {
      throw new Error(
        "FHIR context is not available. Ensure the MCP server is connected " +
          "to a Prompt Opinion workspace with FHIR context enabled.",
      );
    }
    return ctx;
  },

  /**
   * Get patient ID or throw a descriptive error for the MCP response.
   */
  getPatientIdOrThrow: (req: Request, suppliedPatientId?: string): string => {
    const patientId = FhirUtilities.getPatientIdFromContext(req);
    if (!patientId) {
      throw new Error(
        "Patient context is not available. Please select a patient in " +
          "Prompt Opinion before using ResultLoop tools.",
      );
    }
    if (suppliedPatientId && suppliedPatientId !== patientId) {
      logger.warn(
        { suppliedPatientId, contextPatientId: patientId },
        "Ignoring supplied patientId in favor of Prompt Opinion patient context",
      );
    }
    return patientId;
  },
};
