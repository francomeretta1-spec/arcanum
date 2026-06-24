'use strict';

// WSAPOC - Consulta de la base de "Facturas Apocrifas" / contribuyentes con
// comprobantes apocrifos (ex-APOC). Servicio WSAA: `wsapoc`.
//   Operacion: GetPublicacionAPOC(credencial{Token,Sign,CUITDelegado}, cuit)
//   Endpoint .NET (.asmx), namespace tempuri.org, SOAPAction tempuri/{op}.
//
// A diferencia del resto, la credencial va envuelta en <credencial> y el CUIT a
// consultar va suelto en <cuit>. Reusamos el cache de TA (getAccessTicket) para
// NO pedir un token nuevo en cada consulta (evita el baneo de WSAA).

const { config } = require('../config');
const { getAccessTicket } = require('../auth/wsaa');
const { SoapError } = require('../soap/client');
const { normalizeCuit } = require('../auth/tenants');

const SERVICE = 'wsapoc';
const NS = 'http://tempuri.org/';
const OP = 'GetPublicacionAPOC';

function endpoint(entorno) {
  const env = entorno || config.env;
  // Solo prod esta verificado contra ARCA real; homologacion es best-effort.
  return env === 'prod'
    ? 'https://eapoc-ws.afip.gob.ar/service.asmx'
    : 'https://eapoc-ws-qaext.afip.gob.ar/service.asmx';
}

function get(src, tag) {
  const m = src.match(new RegExp('<' + tag + '>([^<]*)</' + tag + '>', 'i'));
  return m ? m[1].trim() : null;
}

/**
 * Consulta si `cuitConsulta` esta en la base de apocrifos, usando el certificado
 * de `cuitRepresentada` (el contador/representante).
 * @returns {Promise<object>} { cuit, esApocrifo, codigo, descripcion, fechaCondicion, fechaPublicacion }
 */
async function consultar(cuitRepresentada, cuitConsulta, entorno) {
  const repre = normalizeCuit(cuitRepresentada);
  const target = normalizeCuit(cuitConsulta);
  if (!target) throw new SoapError('CUIT a consultar invalido', 400);

  const ta = await getAccessTicket(repre, SERVICE, entorno);

  const envelope =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"' +
    ` xmlns:ws="${NS}">` +
    '<soapenv:Header/><soapenv:Body>' +
    `<ws:${OP}>` +
    '<credencial>' +
    `<Token>${ta.token}</Token>` +
    `<Sign>${ta.sign}</Sign>` +
    `<CUITDelegado>${repre}</CUITDelegado>` +
    '</credencial>' +
    `<cuit>${target}</cuit>` +
    `</ws:${OP}>` +
    '</soapenv:Body></soapenv:Envelope>';

  const url = endpoint(entorno);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.soapTimeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: `"${NS}${OP}"` },
      body: envelope,
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new SoapError(`Timeout (${config.soapTimeoutMs}ms) llamando a WSAPOC`, 504);
    throw new SoapError(`No se pudo conectar con WSAPOC: ${e.message}`, 502);
  } finally {
    clearTimeout(timer);
  }
  const xml = await res.text();

  const fault = xml.match(/<(?:[\w]+:)?Fault[^>]*>[\s\S]*?<(?:faultstring|(?:[\w]+:)?Text)[^>]*>([^<]+)/i);
  if (fault) throw new SoapError(`WSAPOC rechazo la solicitud: ${fault[1]}`, 502, { raw: xml.slice(0, 800) });

  const codigo = get(xml, 'Codigo') || get(xml, 'codigo');
  let descripcion = get(xml, 'Descripcion') || get(xml, 'descripcion');

  // Si hay <resultados> con contenido => el CUIT figura como apocrifo.
  const resultados = xml.match(/<resultados>([\s\S]*?)<\/resultados>/i);
  const esApocrifo = !!(resultados && resultados[1].trim());

  let fechaCondicion = null;
  let fechaPublicacion = null;
  let detalle = null;
  if (esApocrifo) {
    fechaCondicion = get(resultados[1], 'FechaCondicion') || get(resultados[1], 'fechaCondicion');
    fechaPublicacion = get(resultados[1], 'FechaPublicacion') || get(resultados[1], 'fechaPublicacion');
    detalle = get(resultados[1], 'Descripcion') || get(resultados[1], 'descripcion');
  }

  // Quirk conocido de ARCA: para monotributistas o CUIT sin antecedentes el WS
  // devuelve codigo 201 + "Object reference not set..." en vez de una respuesta
  // limpia. NO es un error nuestro ni implica apocrifo: es "sin publicaciones".
  const quirk201 = codigo === '201' || /object reference not set/i.test(descripcion || '');
  if (!esApocrifo && quirk201) {
    descripcion = 'Sin publicaciones de apocrifos para el CUIT (ARCA devuelve codigo 201 para monotributistas o CUIT sin antecedentes).';
  }

  return {
    cuit: target,
    esApocrifo,
    codigo,
    descripcion,
    fechaCondicion,
    fechaPublicacion,
    detalle,
  };
}

module.exports = { consultar, SERVICE };
