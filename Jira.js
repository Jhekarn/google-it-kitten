// Jira.js
const axios = require('axios');

const auth = Buffer.from(`${process.env.JIRA_USER}:${process.env.JIRA_TOKEN}`).toString('base64');
const baseUrl = process.env.JIRA_BASE_URL;

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

async function createJiraTicket({ title, description, reporterEmail, projectKey = "IH" }) {
  try {
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

    return createResponse.data;

  } catch (error) {
    console.error("Jira API error:", error.response?.data || error.message);
    throw error;
  }
}

module.exports = { createJiraTicket };
