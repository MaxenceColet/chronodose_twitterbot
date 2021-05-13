import axios from 'axios';
import TwitterApi from 'twitter-api-v2';
import StaticMaps from 'staticmaps';

import dotenv from 'dotenv';
dotenv.config();

import dayjs from 'dayjs';
import calendar from 'dayjs/plugin/calendar';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
dayjs.extend(calendar);
dayjs.extend(utc);
dayjs.extend(timezone);

const twitterClient = new TwitterApi({
  appKey: process.env.APP_KEY!,
  appSecret: process.env.APP_SECRET!,
  accessToken: process.env.ACCESS_TOKEN!,
  accessSecret: process.env.ACCESS_SECRET!,
});

if (!process.env.DEPARTMENTS_TO_CHECK) {
  console.error('please set the DEPARTMENTS_TO_CHECK env variable');
  process.exit(0);
}

const CENTER_LAT = Number(process.env.CENTER_LAT);
const CENTER_LON = Number(process.env.CENTER_LON);
const MAX_RADIUS_KM = Number(process.env.MAX_RADIUS_KM);
const DEPARTMENTS_TO_CHECK = process.env.DEPARTMENTS_TO_CHECK!.split(',').map(Number);
const CHECK_INTERVAL_SEC = Number(process.env.CHECK_INTERVAL_SEC) || 60; // check every X seconds
const MIN_DOSES = Number(process.env.MIN_DOSES) || 0; // don't tweet if less than MIN_DOSES are available, because it's probably already too late
const TIMEZONE = process.env.TIMEZONE || 'Europe/Paris';

// partial data
interface viteMaDoseData {
  centres_disponibles: Array<{
    nom: string;
    url: string;
    location: {
      longitude: number;
      latitude: number;
      city: string;
    }
    metadata: {
      address: string;
    }
    appointment_schedules: Array<{
      name: string;
      from: string;
      to: string;
      total: number;
    }>;
    prochain_rdv: string;
    vaccine_type?: string[];
  }>
}

// avoid tweeting twice the same message (using a specified ID)
const alreadyTweeted = new Set<string>();

async function checkDepartment(department: number) {

  console.log(`fetching db ${department}...`);
  const { data }: { data: viteMaDoseData } =
    await axios.get(`https://vitemadose.gitlab.io/vitemadose/${addZero(department)}.json`);
  console.log(`fetched db ${department}`);

  const promises = data.centres_disponibles
    // .filter(centre => centre.vaccine_type?.includes('Pfizer-BioNTech') || centre.vaccine_type?.includes('Moderna'))
    // .filter(centre => (new Date(centre.prochain_rdv).getTime() - Date.now()) < 24 * 60 * 60 * 1000)
    .filter(centre => (distance(CENTER_LAT,CENTER_LON,centre.location.latitude, centre.location.longitude) <= MAX_RADIUS_KM))
    .filter(centre => centre.appointment_schedules
      .some(schedule => schedule.name === 'chronodose' && schedule.total > 0)
    )
    .map(async (centre) => {
      // count the number of doses
      const nbDoses = centre
        .appointment_schedules
        .filter(schedule => schedule.name === 'chronodose')
        .reduce((nb, schedule) => nb + schedule.total, 0);

      if (nbDoses < MIN_DOSES) {
        return;
      }

      // don't tweet twice the same info
      const id = `${centre.url} - ${centre.prochain_rdv} - ${nbDoses}`
      if (alreadyTweeted.has(id)) {
        return;
      }
      alreadyTweeted.add(id);

      const calendarDate = dayjs(centre.prochain_rdv)
        .tz(TIMEZONE)
        .calendar(dayjs(),
          {
              sameDay: '[aujourd\'hui à] H:mm',
              nextDay: '[demain à] H:mm',
              sameElse: 'le DD/MM/YYYY à H:mm',
          }
      );

      const intro = (nbDoses == 1) ?
        `${nbDoses} dose est disponible ${calendarDate}` :
        `${nbDoses} doses sont disponibles ${calendarDate}`;

      const message =
        `${intro}\n` +
        `à ${centre.nom} (${centre.vaccine_type})\n` +
        `${centre.url}\n` +
        `${centre.metadata.address}`;

      

      

      
      if(process.env.ENV == "TEST"){

        console.log(message);

      }else if(process.env.ENV == "PROD"){

        console.log('generating the map...');

        // generate the map image before tweeting...
        const map = new StaticMaps({
          width: 600,
          height: 400
        });
        map.addMarker({
          coord: [centre.location.longitude, centre.location.latitude],
          img: 'marker.png',
          height: 40,
          width: 40,
        });
        await map.render(undefined, 11);

        // tweet
        console.log('uploading the media...');
        const mediaId = await twitterClient.v1.uploadMedia(await map.image.buffer(), { type: 'png' });
        console.log('tweeting...')
        await twitterClient.v1.tweet(message, { media_ids: mediaId });
      }
      
    });
  await Promise.all(promises)
    .catch(err => console.error(err));
}

function addZero(department: number) {return (department < 10 ? `0${department}` : department)}

function checkDepartments(departments: number[]) {
  return Promise.all(
    departments
      .map(department => checkDepartment(department)),
  )
}

function distance(lat1: number, lon1: number, lat2: number, lon2: number) {
  var p = 0.017453292519943295;    // Math.PI / 180
  var c = Math.cos;
  var a = 0.5 - c((lat2 - lat1) * p)/2 + 
          c(lat1 * p) * c(lat2 * p) * 
          (1 - c((lon2 - lon1) * p))/2;

  return 12742 * Math.asin(Math.sqrt(a)); // 2 * R; R = 6371 km
}

checkDepartments(DEPARTMENTS_TO_CHECK);
setInterval(() => checkDepartments(DEPARTMENTS_TO_CHECK), CHECK_INTERVAL_SEC * 1000)