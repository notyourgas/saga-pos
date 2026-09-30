const allowedHosts = new Set([
  'google.com',
  'www.google.com',
  'maps.google.com',
  'google.co.id',
  'www.google.co.id',
  'maps.app.goo.gl',
  'goo.gl',
]);

const coordinatePattern = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

export async function resolveGoogleMapsLocation(value,{fetchImpl=globalThis.fetch,timeoutMs=5_000,maxRedirects=5}={}) {
  const input=String(value??'').trim();
  if(!input||input.length>2_048)throw failure('maps_location_input_invalid',422);
  const direct=parseCoordinateText(input);
  if(direct&&!/^https?:\/\//i.test(input))return result(direct,'COORDINATES');
  let current=googleMapsUrl(input);
  for(let step=0;step<=maxRedirects;step+=1){
    const coordinates=parseCoordinatesFromUrl(current);
    if(coordinates)return result(coordinates,step?'REDIRECT':'LINK');
    if(step===maxRedirects||typeof fetchImpl!=='function')break;
    let response;
    try{
      response=await fetchImpl(current,{method:'GET',redirect:'manual',headers:{accept:'text/html,application/xhtml+xml','user-agent':'SagaPOS-Location-Resolver/1.0'},signal:AbortSignal.timeout(timeoutMs)});
    }catch{throw failure('maps_location_resolve_failed',422);}
    const location=response?.headers?.get?.('location');
    if(!location||!Number.isInteger(response.status)||response.status<300||response.status>399)break;
    current=googleMapsUrl(new URL(location,current).href);
  }
  throw failure('maps_location_coordinates_not_found',422);
}

export function parseGoogleMapsCoordinates(value){
  const input=String(value??'').trim();
  if(!input)return null;
  const direct=parseCoordinateText(input);
  if(direct&&!/^https?:\/\//i.test(input))return direct;
  try{return parseCoordinatesFromUrl(googleMapsUrl(input));}catch{return null;}
}

function googleMapsUrl(value){
  let parsed;
  try{parsed=new URL(value);}catch{throw failure('maps_location_link_invalid',422);}
  const host=parsed.hostname.toLowerCase().replace(/\.$/,'');
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||!allowedHosts.has(host))throw failure('maps_location_link_invalid',422);
  parsed.hash='';
  return parsed;
}

function parseCoordinatesFromUrl(url){
  let decoded=url.href;
  try{decoded=decodeURIComponent(decoded);}catch{}
  for(const pattern of [/!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/,/@(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/]){
    const match=decoded.match(pattern),coordinates=match?validCoordinates(match[1],match[2]):null;
    if(coordinates)return coordinates;
  }
  let decodedPath=url.pathname;
  try{decodedPath=decodeURIComponent(decodedPath);}catch{}
  if(/(?:^|\/)maps(?:\/|$)/i.test(decodedPath)){
    for(const segment of decodedPath.split('/').reverse()){
      const coordinates=parseCoordinateText(segment.replace(/\+/g,' '));
      if(coordinates)return coordinates;
    }
  }
  for(const key of ['query','q','ll','destination','daddr','center']){
    const coordinates=parseCoordinateText(url.searchParams.get(key));
    if(coordinates)return coordinates;
  }
  return null;
}

function parseCoordinateText(value){
  const match=String(value??'').trim().match(coordinatePattern);
  return match?validCoordinates(match[1],match[2]):null;
}

function validCoordinates(latitude,longitude){
  const lat=Number(latitude),lng=Number(longitude);
  if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)return null;
  return {latitude:round(lat),longitude:round(lng)};
}

function result(coordinates,source){
  const query=`${coordinates.latitude},${coordinates.longitude}`;
  return Object.freeze({...coordinates,source,mapsUrl:`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`});
}

function round(value){return Math.round(value*10_000_000)/10_000_000;}
function failure(code,statusCode){const error=new Error(code);error.code=code;error.statusCode=statusCode;return error;}
