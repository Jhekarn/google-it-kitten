// Jira.js — ticket creation, with TWO flows depending on the target project:
//
//  - JSM SERVICE DESKS (IT Helpdesk, Security): tickets MUST be created as
//    proper SERVICE REQUESTS via the Jira Service Management API
//    (/rest/servicedeskapi/request) — NOT as plain Tasks via the issue API.
//    A Task bypasses the JSM flow entirely: wrong work type, no customer
//    portal view, no JSM notifications/SLAs. `raiseOnBehalfOf` makes the
//    user the requester, and the API returns `_links.web` — the CUSTOMER
//    PORTAL view of the request, which is the link end users can open
//    (they usually cannot open /browse/... at all).
//
//  - Plain Jira software projects (SRE, DX): classic issue API, type Task,
//    reporter set via a follow-up update; link stays /browse/KEY.
const axios = require('axios');

const auth = Buffer.from(`${process.env.JIRA_USER}:${process.env.JIRA_TOKEN}`).toString('base64');
const baseUrl = process.env.JIRA_BASE_URL;

// JSM projects: which service desk + request type the Kitten files into.
// The IDs come straight from the portal's create URL:
//   .../servicedesk/customer/portal/<serviceDeskId>/group/<g>/create/<requestTypeId>
const JSM_REQUEST_TYPES = {
  IH:      { serviceDeskId: '3',  requestTypeId: '12'  }, // IT Support — portal/3/group/5/create/12
  SECHELP: { serviceDeskId: '37', requestTypeId: '362' }  // Security   — portal/37/group/120/create/362
};

const config = {
  headers: {
    Authorization: `Basic ${auth}`,
    Accept: "application/json",
    "Content-Type": "application/json"
  }
};

async function getUserAccountIdByEmail(email) {
  try {
    const url = `${baseUrl}/rest/api/3/user/search?query=${encodeURIComponent(email)}`;
    const response = await axios.get(url, config);
    const users = response.data;

    if (!users.length) {
      console.warn(`⚠️ No Jira user found with email: ${email}`);
      return null;
    }

    return users[0].accountId;
  } catch (error) {
    console.error("Error during Jira user lookup:", error.response?.data || error.message);
    return null;
  }
}

// Create a JSM SERVICE REQUEST (the correct work type for service desks).
// raiseOnBehalfOf makes the USER the requester (they see the request in the
// portal and receive the JSM notifications). If that is rejected — e.g. the
// user is not a customer of that desk yet — the request is created as the
// bot user instead of failing (the "Requested by" line keeps the context).
async function createServiceRequest({ title, description, reporterEmail, jsm }) {
  const body = {
    serviceDeskId: jsm.serviceDeskId,
    requestTypeId: jsm.requestTypeId,
    requestFieldValues: {
      summary: title,
      description: `${description}\n\nRequested by: ${reporterEmail}`
    }
  };
  try {
    const res = await axios.post(`${baseUrl}/rest/servicedeskapi/request`, { ...body, raiseOnBehalfOf: reporterEmail }, config);
    return res.data;
  } catch (error) {
    const status = error.response?.status;
    if (status === 400 || status === 404) {
      console.warn(`⚠️ raiseOnBehalfOf failed for ${reporterEmail} (HTTP ${status}) — creating the request as the bot user.`);
      const res = await axios.post(`${baseUrl}/rest/servicedeskapi/request`, body, config);
      return res.data;
    }
    throw error;
  }
}

// Create a ticket in the right way for the project.
// Returns { key, webUrl } — webUrl is what the confirmation button links to:
// JSM projects → the customer-portal request view; others → /browse/KEY.
async function createJiraTicket({ title, description, reporterEmail, projectKey = "IH" }) {
  try {
    // JSM service desks → service request via the Service Desk API
    const jsm = JSM_REQUEST_TYPES[projectKey];
    if (jsm) {
      const data = await createServiceRequest({ title, description, reporterEmail, jsm });
      const key = data.issueKey;
      const webUrl = data._links?.web || `${baseUrl}/servicedesk/customer/portal/${jsm.serviceDeskId}/${key}`;
      console.log(`🎫 JSM service request created: ${key} (desk ${jsm.serviceDeskId}, request type ${jsm.requestTypeId}, on behalf of ${reporterEmail})`);
      return { key, webUrl };
    }

    // plain Jira project → classic issue API (type Task) + reporter update
    const issueData = {
      fields: {
        project: { key: projectKey },
        summary: title,
        description: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: `${description}\n\nRequested by: ${reporterEmail}` }
              ]
            }
          ]
        },
        issuetype: { name: "Task" }
      }
    };

    const createResponse = await axios.post(`${baseUrl}/rest/api/3/issue`, issueData, config);
    const issueKey = createResponse.data.key;

    const reporterAccountId = await getUserAccountIdByEmail(reporterEmail);

    if (reporterAccountId) {
      await axios.put(
        `${baseUrl}/rest/api/3/issue/${issueKey}`,
        {
          fields: {
            reporter: {
              accountId: reporterAccountId
            }
          }
        },
        config
      );
    } else {
      console.warn(`⚠️ Reporter not updated for issue ${issueKey}. Default reporter (${process.env.JIRA_USER}) retained.`);
    }

    return { key: issueKey, webUrl: `${baseUrl}/browse/${issueKey}` };

  } catch (error) {
    console.error("Jira API error:", JSON.stringify(error.response?.data) || error.message);
    throw error;
  }
}

module.exports = { createJiraTicket };
