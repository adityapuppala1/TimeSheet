/**
 * A tiny, real SAML identity provider for unit tests: it builds Responses and Assertions and SIGNS
 * them with xml-crypto, exactly as Entra, Google Workspace, Okta and ADFS do, so the tests exercise
 * node-saml's actual signature verification rather than a mock of it.
 *
 * THE KEYS BELOW ARE TEST FIXTURES AND SECURE NOTHING. Two self-signed RSA-2048 pairs generated with
 * openssl for this file (`CN=idp-a.test.invalid`, `CN=idp-b.test.invalid`, valid 2026–2056 so the
 * fixture does not turn into a mystery failure in a few years). `.invalid` is reserved by RFC 2606:
 * nothing anywhere trusts these certificates. Two of them, because "signed by somebody else's key"
 * and "the IdP rolled its certificate over" both need a second one.
 *
 * WHAT A SIGNATURE COVERS is the point of most tests that use this, so the three placements are
 * separate functions: the assertion alone (Entra's and Google's default), the response alone (some
 * Okta and ADFS set-ups), or both.
 */
import { SignedXml } from "xml-crypto";

export const IDP_A_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC1wqyPa6CSfzkf
4Yy8VDwqpKjI0KDXIMzCTSY2ZWT+sD7A7sdBnbwXgyWfQi8L8quCUme4WF5r/Ela
eINWwTvtcJJZcWuSq2L2pb1z2T+GOo5otm3bo+PU91Y2GAiSetKxpj/UMAHVdGqt
Lx8w0e6yZDl67QiE7QsbYtTmvpFLPm3g2IP31VNe/x5fZcaPLnX+c9CFkXpOJWFE
mzRk4njZRGQ5wNAhjqkI1qrbHEV/g53QeSYwlZIR/2Pff6MR3X2UOSnVNG1qDuiJ
j0Wuuub3Q0PjjnU6teE61O9t8ZC7Ksp8f6c6fiDrCwFhtUJlTAFls3zI1j8h+sAi
CVnlQ9dBAgMBAAECggEABAvM+Dp/Xht9RN+X4eU5bcu6otqgE6+cDiDNB7bkCo08
DGLLOKga2WZtqKasezi29MCvyVJwRjlT5kUjuVWjgsTcXJVthoBr+19l7rffcVF2
4eHIUQ/VTqRzmD4IXNGKDc5n79eHBuxNQzKbhNIW+IRutrT+vbuiaml5M+FVxOFQ
hJusAjWR/eL69FdRruVZY2ld0eas+Hl2F+6z1piWW9wlI+B7JFRolUNbwbbQbKm5
1zba7jtQx8q1qgyF6cJNeaZobIZBsgBel5g5M/YHL/QB35oIBFnVbhoqSg90Zie3
i17dSNYT0cAKACKONe29R/0IT2sKisVU5rDPusxElQKBgQDl9x2CH7V+N/c+tqHb
1J+Wg5bl9/jddut/2VFpsKCjIpG+8BN02tMxqfHNgeJHpIs0YereZaJZQWI1r/WN
kkPdxdF5OcYEyjkzNpV5VNz641jc7QPD7QwwtQ/+vVA7SCbgmsuCWuX3D4TBDfrm
R8gG9Cmv8voSdaNiC4rs1uZoJQKBgQDKVnq+bq5YncN/V4weIWMpOL06MnZi2EQN
bpU3tBncAJ9bGgbe71libxRQlFFpfqs9VDzYztyCHQ3bHyGB2VSb1cU8l5OlaaU1
4pJ6inISnEnkLVNdmnjdQuCqYo0JL5ZWhfPG3v3uSexiWe9a/wxHmaku1A5hSUN9
ZNAJPdGp7QKBgG8PuHWWoM2Tc9oa0/LaLjS/2om4B73VaAj3yITVo88FrAPd6Feg
My0iGUCaANF+2yfyPj8oMI8Qr8Cj+WBlCle56N+2EjdP/u4H54qQfKTCVbFk2lOu
URvY5h+uCGiJARWqTKzo/3UhToj6GnlKo4UQOG3cV//ARqbcUjzt0JrtAoGBAKHh
eIh9Is3RQsTR9U9x5NTpCTPThbXlUuTwMUAEvp+ue9A2TYL1Oa0wM6+YSl49sqD5
kUjgj7klp51FFdi+WRvodsnYd47irAQlho210DglhFSjEsyTttlHFVocSLwtr3j/
6J6Wb9DCofW6AG7sGRX70Uie7fZV2EItcufB5smtAoGBALvXyyJgrL/uAaXYs++M
wHvBYD4LlO99GldAnrzzVpwJqCY9+CJWNi9LoqJN8WB36wmhuWV8H5BWhSXrMWCZ
YwP5HB1RAGisdg4QLsof3rgQxvnP3qrEzJvKbeCfVXpKl1BBbGPPbhS3I56mH4+Q
qZa/x146CNt2T0ldZo8QfjQd
-----END PRIVATE KEY-----`;

export const IDP_A_CERT = `-----BEGIN CERTIFICATE-----
MIIDXTCCAkWgAwIBAgIUC5YewSWkAsYFpnDKnnlwUcSVOy0wDQYJKoZIhvcNAQEL
BQAwPTEbMBkGA1UEAwwSaWRwLWEudGVzdC5pbnZhbGlkMR4wHAYDVQQKDBVUaW1l
U3BoZXJlIHRlc3QgSWRQIGEwIBcNMjYxMDAyMDUyMDMzWhgPMjA1NjA5MjQwNTIw
MzNaMD0xGzAZBgNVBAMMEmlkcC1hLnRlc3QuaW52YWxpZDEeMBwGA1UECgwVVGlt
ZVNwaGVyZSB0ZXN0IElkUCBhMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC
AQEAtcKsj2ugkn85H+GMvFQ8KqSoyNCg1yDMwk0mNmVk/rA+wO7HQZ28F4Mln0Iv
C/KrglJnuFhea/xJWniDVsE77XCSWXFrkqti9qW9c9k/hjqOaLZt26Pj1PdWNhgI
knrSsaY/1DAB1XRqrS8fMNHusmQ5eu0IhO0LG2LU5r6RSz5t4NiD99VTXv8eX2XG
jy51/nPQhZF6TiVhRJs0ZOJ42URkOcDQIY6pCNaq2xxFf4Od0HkmMJWSEf9j33+j
Ed19lDkp1TRtag7oiY9Frrrm90ND4451OrXhOtTvbfGQuyrKfH+nOn4g6wsBYbVC
ZUwBZbN8yNY/IfrAIglZ5UPXQQIDAQABo1MwUTAdBgNVHQ4EFgQUKJlTgORF3n60
7Y0O2o1LNaaDLRIwHwYDVR0jBBgwFoAUKJlTgORF3n607Y0O2o1LNaaDLRIwDwYD
VR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAIWEh7czB4/NgxAeMXDLc
C4ZYYSSJ3N7SwitIhLoRdVaZaB3Xqnn0PUl2llzU+VsWG4CHppaGZw/mIAnNOOsD
hpKNWLfaHZa6c1oNhtbuAKRsYM+8vXFtHG3xm0lKkgcIbeqd8011mTSSvD5gIYbw
UQyAys5pFQxWaTJasamUhpTiTGbA3Yg6r6b+Qg9yWz8TaY9scuZPkCSoUepRYxvA
isb1CHoI8W0Q7MzMCk9neveMwoqhtD29SkDfVX0Kag/4utRTs8p6b1eXPPL2eJr7
hRj5+sD3FVyrH5eWosMyErBwYRQm84CMEvoDN6ropOxqhhBIS5wwpH+WMiqzAq3e
IA==
-----END CERTIFICATE-----`;

export const IDP_B_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDIDID1M63M8bTg
ETUTPVe4nJSpEZyHfHbcmAcasYUjk2KvLcymKZrw9fm5OQhj0Gr7LE/pBOvusLTL
m9obLVHbKXP/+ihZrz0p1JTG6oh+B7dIUPFcN2pxLa/4IZuxwnwnj2BbX10T+szH
2ZRofhODZCcX5quq4hGYgDh6ccYJQSvwq0uVDyHulkH4FCtqwYMdMtXB+NXdB7oA
FsWlejLxGNq0aUJuCqqMpAcWEFo/5Qq2E3CWu6vX42LpY0Zbo4a62D6bFxMqJGCq
iRLPg8cDVELAobFtTD2541HzuM+g4L593nAHOj4C+jTMLZ6OC49Mumcl9lxOvV/H
hvhyO4HDAgMBAAECggEASN0ZCXaZysiM74IE+W2B6nmJwizqfQTODFoJWGUpT8Rq
kNDXNfx4dWS6YQcPcb+jf7nrnz2OK8HMEE9DeVuf8XofSLCWitgDqJ1H1U3uii0I
SnxE9SgwCmowKmofWfczHnugBpftAI58kRxEbGzjcZuEi7WWeGbgLtIhACQ5k/u1
tTANpiwTUZpyczR/s+ql7XiuCfm5YZj0o1Josk9fq+OCmUimmJlbGquSH/RKU8dn
C1i8g0iuJJQYl9FGu/mzyl7JuofMKUfvsFefU2hVQyI/TOjEsdaayJD+a2D4bpaF
IWqgBdTuQe5T/tuSkrlkLQ672TtSB92CWjyI/Hky9QKBgQD6KFnBV+5UpTnOGT3b
X+OFNfLgsb/VJ4IlYvSKc/gReaz0fODS5t1WnZLeFaJBS/ruhfbLG1DzmRs8zt/l
EUhhIYU/ypboX4W5k6wZkRo5I7qOPCvleU4u5SU+y2kNJU2pABuENVw0o9lgqNs9
MO/HMqBXZZDsSE8PuSS+JzV8fQKBgQDMuI+2PTeFnNJtYsa7HJttIa0KsW5ZH8Fj
g4+A2M4Q5O7gzwDr9k4hzT7OVLGSvsb+mKVzOKpRJcOoph2poq26cac/Ck+cGcgm
z2b7AJbLN9d+ySvnTgxpUqPiu3FQPS4CG3qiEq/ZtpdcxDzCqgqV/1sUfJ7oVhkB
52P30oKLPwKBgF0yaz385G3koISIIuN39evLDZFop29iKLqFA1YRnnnkOutbGud3
2z5Jtk3HAYwSIop6nldM9fvLLrqY2BEfPzfwpRP/BfnMnKVmvtdHl91x0i7re+8i
Il6WQCoE3j5nh2dPAvFeb9usr2+zePpzIOG1msb0r+lXhxz0fRvav7KBAoGAHk2v
kDVNk6ycBW8apbXdV/ElMTEEeZLWyIk/472z+xI4PfTGWSdTd3NvOZGV23f78tHb
o8uegnaJmNxGBcc72h5auF0pXZz/YKdQwhTbPWedsXnL0uhds/V0pupCIrN7rPou
U/FaMGrzytqNd+89s+hhrg2oZBHij8KVrKhvhHcCgYEAgzAiKg89roBJwhF3YM/y
kF+eDPDnB5PhivB8WZ9GIBCB4J9Bmp93BQ5HvbxRIt05G+/oR5WH5VnKO9YPWaok
9PLo6vTKP4PxJN7DurH6u4qClqykdXuoO1hvRd+z2tcA0JfTMox9xvCmr2yqSeAg
O6oJaMf8HR5V4njv2ebijNc=
-----END PRIVATE KEY-----`;

export const IDP_B_CERT = `-----BEGIN CERTIFICATE-----
MIIDXTCCAkWgAwIBAgIUQuFIiOwMnj695poPZCppWV8S+OUwDQYJKoZIhvcNAQEL
BQAwPTEbMBkGA1UEAwwSaWRwLWIudGVzdC5pbnZhbGlkMR4wHAYDVQQKDBVUaW1l
U3BoZXJlIHRlc3QgSWRQIGIwIBcNMjYxMDAyMDUyMDMzWhgPMjA1NjA5MjQwNTIw
MzNaMD0xGzAZBgNVBAMMEmlkcC1iLnRlc3QuaW52YWxpZDEeMBwGA1UECgwVVGlt
ZVNwaGVyZSB0ZXN0IElkUCBiMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC
AQEAyAyA9TOtzPG04BE1Ez1XuJyUqRGch3x23JgHGrGFI5Niry3Mpima8PX5uTkI
Y9Bq+yxP6QTr7rC0y5vaGy1R2ylz//ooWa89KdSUxuqIfge3SFDxXDdqcS2v+CGb
scJ8J49gW19dE/rMx9mUaH4Tg2QnF+arquIRmIA4enHGCUEr8KtLlQ8h7pZB+BQr
asGDHTLVwfjV3Qe6ABbFpXoy8RjatGlCbgqqjKQHFhBaP+UKthNwlrur1+Ni6WNG
W6OGutg+mxcTKiRgqokSz4PHA1RCwKGxbUw9ueNR87jPoOC+fd5wBzo+Avo0zC2e
jguPTLpnJfZcTr1fx4b4cjuBwwIDAQABo1MwUTAdBgNVHQ4EFgQU6oCkeaMr4a8r
KuIeqh2Lk09VYbswHwYDVR0jBBgwFoAU6oCkeaMr4a8rKuIeqh2Lk09VYbswDwYD
VR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAut0fLtjS2N1KgFiiQP66
HnsS1nHBSrC1xmd1s25ksbj/sJ+mDg7WJ8C9l7KkkL0Ja23dhJO4oIy7JVcr0Me4
tXeM0VJNlb7uHeVB+EG7yJnVorqTUQi9QdZ5ZVxWmu5MmmIUMWcFzoJs7fSJtaKD
t9+viGFIfbSXfgyiO7LPXzbD+qfiY6S3mFJA7CHrGJpYytfshGAnUqYflLWDaWrg
Fvh1R7142eorS4bJJBcD+GWd6gCOCr+Icla4Cc6FKm8fyiO70t9Fv0IEsdw7rE+G
HYTxBHFdxw8Jq9GTG1sw0wQ46E6H2bp3GUIrGaT+rPSVKnF866N5tOgo6t6Y6VDA
Pg==
-----END CERTIFICATE-----`;

const iso = (ms: number) => new Date(ms).toISOString();

export interface AssertionOptions {
  id?: string;
  issuer: string;
  audience: string;
  inResponseTo: string;
  /** Omitted from SubjectConfirmationData when null — not every IdP sends it. */
  recipient: string | null;
  nameId: string;
  nameIdFormat?: string;
  /** Attribute Name → value, rendered as an AttributeStatement. */
  attributes?: Record<string, string>;
  /** Shifts NotBefore/IssueInstant, to model an IdP whose clock runs ahead of ours. */
  clockOffsetMs?: number;
}

export function assertionXml(o: AssertionOptions): string {
  const now = Date.now() + (o.clockOffsetMs ?? 0);
  const later = now + 5 * 60_000;
  const recipient = o.recipient === null ? "" : ` Recipient="${o.recipient}"`;
  const attributes = Object.entries(o.attributes ?? {})
    .map(([name, value]) => `<saml:Attribute Name="${name}"><saml:AttributeValue>${value}</saml:AttributeValue></saml:Attribute>`)
    .join("");
  return (
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${o.id ?? "_assertion-1"}" Version="2.0" IssueInstant="${iso(now)}">` +
    `<saml:Issuer>${o.issuer}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="${o.nameIdFormat ?? "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"}">${o.nameId}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${iso(later)}" InResponseTo="${o.inResponseTo}"${recipient}/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(now - 1000)}" NotOnOrAfter="${iso(later)}"><saml:AudienceRestriction><saml:Audience>${o.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(now)}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    (attributes ? `<saml:AttributeStatement>${attributes}</saml:AttributeStatement>` : "") +
    `</saml:Assertion>`
  );
}

export function responseXml(o: { issuer: string; inResponseTo: string; destination: string | null; body: string }): string {
  const destination = o.destination === null ? "" : ` Destination="${o.destination}"`;
  return (
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response-1" Version="2.0" IssueInstant="${iso(Date.now())}" InResponseTo="${o.inResponseTo}"${destination}>` +
    `<saml:Issuer>${o.issuer}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    o.body +
    `</samlp:Response>`
  );
}

function sign(xml: string, xpath: string, insertAfter: string, key: string, cert: string): string {
  const signer = new SignedXml({
    privateKey: key,
    publicCert: cert,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#"
  });
  signer.addReference({
    xpath,
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256"
  });
  signer.computeSignature(xml, { location: { reference: insertAfter, action: "after" } });
  return signer.getSignedXml();
}

/** Signs a standalone Assertion — the signature goes after its Issuer, as the schema requires. */
export function signAssertion(xml: string, key = IDP_A_KEY, cert = IDP_A_CERT): string {
  return sign(xml, "//*[local-name(.)='Assertion']", "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", key, cert);
}

/** Signs the whole Response envelope, whatever is inside it. */
export function signResponse(xml: string, key = IDP_A_KEY, cert = IDP_A_CERT): string {
  return sign(xml, "/*[local-name(.)='Response']", "/*[local-name(.)='Response']/*[local-name(.)='Issuer']", key, cert);
}

export const toBase64 = (xml: string) => Buffer.from(xml, "utf8").toString("base64");
