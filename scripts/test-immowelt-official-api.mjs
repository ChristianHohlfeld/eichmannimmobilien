import assert from "node:assert/strict";
import {
  buildListCustomerProjectsEnvelope,
  buildEstateExposeEnvelope,
  extractEstatePropertiesFromListResponse,
  parseXmlExposeDetails,
} from "./lib/immowelt-official-api.mjs";

const env = buildListCustomerProjectsEnvelope("KEY<>&", { page: 2, pageSize: 10 });
assert.match(env, /ApiKey>KEY&lt;&gt;&amp;</);
assert.match(env, /CurrentPage>2</);
assert.match(env, /GetListCustomerProjects/);

const ex = buildEstateExposeEnvelope("abc", "c6b1d820-4e82-416d-95ad-22472a129955");
assert.match(ex, /ExposeAuthenticationHeader/);
assert.match(ex, /EstateGuid>c6b1d820-4e82-416d-95ad-22472a129955</);

const listXml = `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetListCustomerProjectsResponse>
      <GetListCustomerProjectsResult>
        <Status>OK</Status>
        <EstatePropertyList>
          <EstateProperty guid="c6b1d820-4e82-416d-95ad-22472a129955">
            <Category estateTypeID="1" saleRentID="1">Wohnung</Category>
            <Description>Schöne Wohnung am See</Description>
            <Zip>78462</Zip><City>Konstanz</City>
            <Price Complete="450000">450.000 €</Price>
            <LivingArea value="78" unit="m²" separable="false">78</LivingArea>
            <Rooms>3</Rooms>
            <PreviewImage>https://mms.immowelt.de/preview.jpg</PreviewImage>
            <UrlExpose>https://www.immowelt.de/expose/c6b1d820-4e82-416d-95ad-22472a129955</UrlExpose>
          </EstateProperty>
        </EstatePropertyList>
        <TotalCount>1</TotalCount><PageSize>50</PageSize><CurrentPage>1</CurrentPage>
      </GetListCustomerProjectsResult>
    </GetListCustomerProjectsResponse>
  </soap:Body>
</soap:Envelope>`;

const props = extractEstatePropertiesFromListResponse(listXml);
assert.equal(props.length, 1);
assert.equal(props[0].id, "c6b1d820-4e82-416d-95ad-22472a129955");
assert.equal(props[0].price, "450.000 €");
assert.equal(props[0].rooms, "3 Zimmer");
assert.ok(props[0].images.length >= 1);

const details = parseXmlExposeDetails(`
<Expose>
  <Titel>Penthouse Konstanz</Titel>
  <Beschreibung>${"A".repeat(90)}</Beschreibung>
  <Referenznummer>A12</Referenznummer>
  <Bilder>
    <Bild><Url>https://mms.immowelt.de/1.jpg</Url></Bild>
    <Bild><Url>https://mms.immowelt.de/2.jpg</Url></Bild>
  </Bilder>
</Expose>`);
assert.equal(details.title, "Penthouse Konstanz");
assert.equal(details.reference_number, "A12");
assert.equal(details.images.length, 2);
assert.ok(details.description.length >= 80);

console.log("test-immowelt-official-api: ok");
