process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://a549306c82814cb8a1118c1695718eee:ed5e5794595a4182acf408de4e088037@sentry.cozycloud.cc/37'

const {
  BaseKonnector,
  requestFactory,
  log,
  errors,
  signin,
  scrape,
  saveBills
} = require('cozy-konnector-libs')

// cheerio & moment are dependencies from cozy-konnect-libs
const moment = require('moment')

const pdf = require('pdfjs')

const querystring = require('querystring')
const html2pdf = require('./html2pdf')

const DEBUG = false

const baseUrl = 'https://secure.booking.com/'

const necessaryHeaders = {
  Referer: baseUrl,
  Accept: 'text/html',
  'Accept-Language': 'en'
}
const request = requestFactory({
  debug: DEBUG,
  cheerio: true,
  jar: true,
  headers: necessaryHeaders
})

const redirectInJSRegexp = /setTimeout\(\n*function\(\) {\n*document\.location\.href *= *'(.*?)'(?: *\+ *)*(?:'(.*?)')*(?: *\+ *)*(?:'(.*?)')*(?: *\+ *)*(?:'(.*?)')*(?: *\+ *)*;?\n*} *, *\d+\n*\);/g

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  const $ = await request(`${baseUrl}myreservations.html`)
  log('info', 'Parsing ...')
  const items = await parseBookings($)
  log('info', `Got ${items.length} bookings, building PDFs ...`)
  const files = await Promise.all(items.map(toFileEntry).filter(Boolean))
  log('info', 'Saving PDFs ...')
  await saveBills(files, fields, {
    contentType: 'application/pdf',
    identifiers: ['booking.com']
  })
}

async function authenticate(username, password) {
  await signin({
    debug: DEBUG,
    url: `${baseUrl}myreservations.html`,
    formSelector: '.js-user-access-form--signin',
    formData: { username, password },
    headers: necessaryHeaders,
    validate: (statusCode, $) => {
      if (statusCode !== 200) throw errors.VENDOR_DOWN
      const matches = redirectInJSRegexp.exec($('body script').html())
      if (!matches || matches.length < 2) {
        log('warning', 'signin flow has changed')
        throw errors.VENDOR_DOWN
      }

      const qs = matches.slice(2).join('')
      const error_code = querystring.parse(qs)['has_error']
      if (error_code == 0) {
        return true
      } else {
        return false
      }
    }
  })
}

function parseDateBlock(node) {
  const day = node
    .find('.mb-dates__day')
    .text()
    .trim()
  const monthAndYear = node
    .find('.mb-dates__month')
    .text()
    .trim()
  return moment(`${day} ${monthAndYear}`, 'DD MMM YYYY')
}

async function parseBookings($) {
  return scrape(
    $,
    {
      name: {
        sel: '.mb-block__hotel-name a',
        fn: node => node.text().trim()
      },
      picture: {
        sel: '.mb-block__photo img',
        fn: node => node.attr('src')
      },
      start: {
        sel: '.mb-dates__block.floatLeft',
        fn: parseDateBlock
      },
      end: {
        sel: '.mb-dates__block.floatRight',
        fn: parseDateBlock
      },
      bookingNb: {
        sel: '.mb-block__book-number b.marginRight_5',
        fn: node => node.text().trim()
      },
      confirmNb: {
        sel: '.mb-block__book-number b:not(.marginRight_5)',
        fn: node => node.text().trim()
      },
      price: {
        sel: '.mb-block__price .mb-block__price__big',
        fn: node => node.text().trim()
      },
      seeBookingUrl: {
        sel: '.mb-block__actions .res-actions__item-link',
        fn: node => node.attr('href')
      }
    },
    '.js-booking_block'
  )
}

async function toFileEntry(item) {
  const pdf = item.confirmNb
    ? await makeConfirmationPDF(item)
    : await makeOldBookingPDF(item)

  const now = moment()

  return {
    filename: item.start.format('YYYY-MM-DD') + '-' + item.name + '.pdf',
    filestream: pdf._doc,
    vendor: 'booking.com',
    date: item.start.isBefore(now) ? item.start.toDate() : now,
    amount: parseFloat(item.price.replace('€', '').replace(',', '.'))
  }
}

const helveticaFont = new pdf.Font(require('pdfjs/font/Helvetica.json'))
const helveticaBoldFont = new pdf.Font(
  require('pdfjs/font/Helvetica-Bold.json')
)

function makeCell(doc, text) {
  return doc
    .cell({ paddingBottom: 0.5 * pdf.cm })
    .text()
    .add(text, { font: helveticaBoldFont, fontSize: 14 })
}

function makeRow(table, ...texts) {
  const row = table.row()
  for (let text of texts) row.cell(text, { padding: 5 })
}

async function makeOldBookingPDF(item) {
  var doc = new pdf.Document({ font: helveticaFont })
  makeCell(doc, 'Booking.com Réservation ' + item.bookingNb)
  makeCell(
    doc,
    'Généré automatiquement par le connecteur booking.com depuis la page '
  ).add(`${baseUrl}/myreservations.html`, {
    link: `${baseUrl}/myreservations.html`,
    color: '0x0000FF'
  })
  makeCell(doc, item.name)
  const table = doc.table({
    widths: ['*', '*'],
    borderWidth: 1
  })
  makeRow(table, 'Réservation #', item.bookingNb)
  makeRow(table, 'Price', item.price)
  makeRow(table, 'Start', item.start.format('YYYY-MM-DD'))
  makeRow(table, 'End', item.end.format('YYYY-MM-DD'))
  doc.end()
  return doc
}

async function makeConfirmationPDF(item) {
  if (!item.seeBookingUrl) return false

  let bookingPage$ = await request(`${baseUrl}${item.seeBookingUrl}`)
  const confirmationURL = bookingPage$('.view_conf').attr('href')
  let $ = await request(`${baseUrl}${confirmationURL}`)
  var doc = new pdf.Document({ font: helveticaFont })
  makeCell(doc, 'Booking.com Confirmation #' + item.bookingNb)
  makeCell(
    doc,
    'Généré automatiquement par le connecteur booking.com depuis la page'
  ).text(`${baseUrl}${item.seeBookingUrl}`, {
    link: `${baseUrl}${item.seeBookingUrl}`,
    color: '0x0000FF'
  })

  $(
    '#column_holder .section' +
      ':not(.bankcard_wrapper)' +
      ':not(.conf-faq)' +
      ':not(#xsell_conf_cyt)' +
      ':not(.newsletter_selection)' +
      ':not(#conf_send)'
  ).each((i, el) => {
    html2pdf($, doc, $(el), {
      baseURL: baseUrl,
      filter: $el => {
        return (
          !$el.hasClass('conf_spec_req') &&
          !$el.hasClass('conf_spec_req--success') &&
          !$el.hasClass('conf_spec_req--error') &&
          !$el.hasClass('conf-slidebox--checkin-time') &&
          !$el.hasClass('rt_resort_credits_info--policy') &&
          !$el.hasClass('join-banner') &&
          $el.attr('id') !== 'conf_send'
        )
      }
    })
  })
  doc.end()
  return doc
}
