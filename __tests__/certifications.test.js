import fs from "fs";
import path from "path";
import {
  certificationAttributes,
  certificationEventFields,
  documentProblems,
  identificationProblems,
} from "../src/mint/certifications.js";
import { validateMetadata } from "../src/mint/metadataValidator.js";
import { buildMetadata, withPlaceholderAssets } from "../src/mint/lib.js";
import { metadataFromForm } from "../src/mint/formPost.js";
import { mintSteps as umina } from "../src/mint/umina.js";

// Third-party certificates of type and quality (umina-achala-chain#38)

const typeCert = (fields = {}) => ({
  issuer: "Sample Gem Lab",
  report_no: "SGL-2026-00121",
  date: "2026-11-17",
  verify_url: "https://example.org/verify/SGL-2026-00121",
  covers: ["type"],
  identification: "Natural opal, Andean blue",
  document: "ipfs://QmLab",
  ...fields,
});
const qualityCert = (fields = {}) => ({
  issuer: "Sample Grading Service",
  report_no: "SGS-2026-0045",
  date: "2026-11-18",
  covers: ["quality"],
  grade: "A",
  document: "ipfs://QmGrade",
  ...fields,
});

const example = () => withPlaceholderAssets(JSON.parse(fs.readFileSync("./json/umina-example.json", "utf8")));
const withCerts = (certifications, stoneType = "opal") => {
  const metadata = example();
  metadata.properties.stone_type = stoneType;
  delete metadata.properties.materials;
  metadata.properties.certifications = certifications;
  return metadata;
};
const errorsOf = (metadata) => JSON.stringify(validateMetadata(metadata).errors);

describe("certifications in the schema and validator", () => {
  test("accepts a type certificate and a quality certificate from different issuers", () => {
    expect(validateMetadata(withCerts([typeCert(), qualityCert()])).valid).toBe(true);
  });

  test("accepts one certificate covering both, with no verify_url", () => {
    const both = typeCert({ covers: ["type", "quality"], grade: "AA", verify_url: undefined });
    delete both.verify_url;
    expect(validateMetadata(withCerts([both])).valid).toBe(true);
  });

  test.each(["issuer", "report_no", "date", "covers", "document"])("requires %s in each entry", (field) => {
    const cert = typeCert();
    delete cert[field];
    const metadata = withCerts([cert]);
    expect(validateMetadata(metadata).valid).toBe(false);
    expect(errorsOf(metadata)).toContain(field);
  });

  test("requires identification when it covers type, and grade when it covers quality", () => {
    const noId = typeCert();
    delete noId.identification;
    expect(errorsOf(withCerts([noId]))).toContain("identification");
    const noGrade = qualityCert();
    delete noGrade.grade;
    expect(errorsOf(withCerts([noGrade]))).toContain("grade");
  });

  test("refuses anything but type and quality in covers, an unknown field, and an empty list", () => {
    expect(validateMetadata(withCerts([typeCert({ covers: ["origin"] })])).valid).toBe(false);
    expect(validateMetadata(withCerts([typeCert({ lab_notes: "x" })])).valid).toBe(false);
    expect(validateMetadata(withCerts([])).valid).toBe(false);
  });

  test("refuses a document that is not a pinned ipfs:// URI in the built metadata", () => {
    expect(validateMetadata(withCerts([typeCert({ document: "opal_a_lab-report.pdf" })])).valid).toBe(false);
  });

  test("refuses a type certificate that names another stone", () => {
    const metadata = withCerts([typeCert({ identification: "Natural chalcedony, blue" })]);
    expect(validateMetadata(metadata).valid).toBe(false);
    expect(errorsOf(metadata)).toContain('does not name the stone type \\"opal\\"');
  });
});

describe("identificationProblems", () => {
  const props = (identification, stone_type = "opal", covers = ["type"]) => ({
    stone_type,
    certifications: [{ covers, identification }],
  });

  test("accepts the English or Spanish name, any case or accents, or the id", () => {
    expect(identificationProblems(props("Natural OPAL, Andean blue"))).toEqual([]);
    expect(identificationProblems(props("Ópalo natural andino"))).toEqual([]);
    expect(identificationProblems(props("opalo azul"))).toEqual([]);
    expect(identificationProblems(props("Natural quartz, variety citrine", "quartz"))).toEqual([]);
  });

  test("needs the name as a whole word: opalescent quartz is not an opal", () => {
    expect(identificationProblems(props("Opalescent quartz"))).toHaveLength(1);
  });

  test("ignores a quality-only certificate, and an unknown stone type (reported elsewhere)", () => {
    expect(identificationProblems(props("Glass", "opal", ["quality"]))).toEqual([]);
    expect(identificationProblems(props("Glass", "not_a_stone"))).toEqual([]);
  });
});

describe("documentProblems", () => {
  const base = "/posts";
  const documents = [{ file: "/posts/opal_a_lab-report.pdf" }, { file: "/posts/opal_a_store-receipt.pdf" }];

  test("resolves each document against the post's folder when it is one of the documents", () => {
    const { problems, certifications } = documentProblems(
      { certifications: [typeCert({ document: "opal_a_lab-report.pdf" })] },
      documents,
      base,
    );
    expect(problems).toEqual([]);
    expect(certifications[0].document).toBe(path.resolve(base, "opal_a_lab-report.pdf"));
  });

  test("refuses a certificate whose report is not in documents", () => {
    const { problems } = documentProblems(
      { certifications: [typeCert({ document: "opal_a_grading-report.pdf" })] },
      documents,
      base,
    );
    expect(problems).toEqual([
      'properties.certifications[0].document "opal_a_grading-report.pdf" is not in documents: add the report to the post\'s documents',
    ]);
  });

  test("has nothing to do without certifications", () => {
    expect(documentProblems({}, documents, base)).toEqual({ problems: [], certifications: undefined });
  });
});

describe("certificationAttributes and certificationEventFields", () => {
  test("Certified by names each issuer once; Certified grade comes from quality certificates", () => {
    expect(certificationAttributes({ certifications: [typeCert(), qualityCert()] })).toEqual([
      { trait_type: "Certified by", value: "Sample Gem Lab, Sample Grading Service" },
      { trait_type: "Certified grade", value: "A" },
    ]);
    expect(certificationAttributes({ certifications: [typeCert(), typeCert({ report_no: "2" })] })).toEqual([
      { trait_type: "Certified by", value: "Sample Gem Lab" },
    ]);
  });

  test("two quality certificates: each grade names its issuer", () => {
    const certs = [qualityCert(), qualityCert({ issuer: "Other Lab", grade: "AA" })];
    expect(certificationAttributes({ certifications: certs })[1]).toEqual({
      trait_type: "Certified grade",
      value: "A (Sample Grading Service), AA (Other Lab)",
    });
  });

  test("none without certifications", () => {
    expect(certificationAttributes({})).toEqual([]);
    expect(certificationEventFields({})).toBeUndefined();
  });

  test("the COMPLIANCE event carries issuer and report number of each", () => {
    expect(certificationEventFields({ certifications: [typeCert(), qualityCert()] })).toEqual([
      { issuer: "Sample Gem Lab", report_no: "SGL-2026-00121" },
      { issuer: "Sample Grading Service", report_no: "SGS-2026-0045" },
    ]);
  });
});

describe("certifications through the mint", () => {
  test("a form post's certificate document is resolved against the post's folder", () => {
    const template = JSON.parse(fs.readFileSync("./json/umina-template.json", "utf8"));
    const form = { stone_id: "UMINA-2026-OP-01", certifications: [typeCert({ document: "opal_a_lab-report.pdf" })] };
    const filled = metadataFromForm(form, template, "/posts");
    expect(filled.properties.certifications[0].document).toBe(path.resolve("/posts", "opal_a_lab-report.pdf"));
  });

  test("buildMetadata links each certificate to its pinned report", () => {
    const file = "/posts/opal_a_lab-report.pdf";
    const metadata = { properties: { certifications: [typeCert({ document: file })] } };
    const documents = [{ file, mime: "application/pdf", description: "Lab report" }];
    expect(buildMetadata(metadata, [], new Map([[file, "QmReport"]]), documents).properties.certifications[0].document).toBe(
      "ipfs://QmReport",
    );
    expect(buildMetadata(metadata, [], undefined, documents).properties.certifications[0].document).toBe("ipfs://pending");
  });

  test("an Umiña's COMPLIANCE adds the certificates; its attributes put them after the stone type", () => {
    const properties = { stone_type: "opal", specimen_form: "worked", certifications: [typeCert(), qualityCert()] };
    expect(umina.complianceFields(properties).certifications).toHaveLength(2);
    expect(umina.complianceFields({ stone_type: "opal" })).not.toHaveProperty("certifications");
    const attributes = umina.withAttributes({
      properties,
      attributes: [
        { trait_type: "Grading", value: "Collector Grade" },
        { trait_type: "Certified by", value: "typed in the post" },
      ],
    }).attributes;
    expect(attributes.map((a) => a.trait_type)).toEqual(["Stone Type", "Form", "Certified by", "Certified grade", "Grading"]);
    expect(attributes[2].value).toBe("Sample Gem Lab, Sample Grading Service");
  });
});
